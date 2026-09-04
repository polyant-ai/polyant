// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { auth } from "@ai-sdk/mcp";
import { Public } from "../../auth/decorators/public.decorator.js";
import { consumeOAuthState } from "./oauth-states.store.js";
import { getMcpServer } from "../../instances/mcp-servers.store.js";
import { makeMcpOAuthProvider } from "../../agents/tools/mcp/mcp-oauth-provider.js";
import { asInstanceUuid } from "../../instances/identifiers.js";
import { resolveInstanceSlug } from "../../instances/resolve-instance-id.js";
import { errMsg } from "../../utils/error.js";
import { mcpLog } from "../../agents/tools/mcp/mcp-logger.js";

/** Escape the 5 HTML-significant characters (mirrors oauth-callback.controller.ts). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Minimal browser-facing page. The user lands here after authorizing. */
function page(title: string, body: string): string {
  const t = escapeHtml(title);
  const b = escapeHtml(body);
  return `<!doctype html><meta charset="utf-8"><title>${t}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h2>${t}</h2><p>${b}</p></body>`;
}

// Redirect URI for MCP-native OAuth (@ai-sdk/mcp's `auth()`), distinct from the
// generic `/oauth/:provider/callback` used by tool-level OAuth providers.
// `state` is a single-use nonce mapped (via oauth_states) to the conversation +
// `mcp:<serverSlug>` provider key. Runs OUTSIDE a pipeline turn → the SDK's
// `auth()` exchanges the code and writes tokens directly into the vault via the
// provider's `saveTokens`.
@Controller("mcp/oauth")
export class McpOAuthCallbackController {
  @Public()
  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!code || !state) {
      res.status(400).type("html").send(page("Error", "Missing parameters"));
      return;
    }

    // Consume the single-use state nonce (CSRF guard) before any further work.
    const pending = await consumeOAuthState(state);
    if (!pending || !pending.provider.startsWith("mcp:")) {
      res.status(400).type("html").send(page("Error", "Invalid or expired state"));
      return;
    }

    const serverSlug = pending.provider.slice("mcp:".length);
    const instanceUuid = asInstanceUuid(pending.instanceId);
    const server = await getMcpServer(instanceUuid, serverSlug);
    if (!server) {
      res.status(404).type("html").send(page("Error", "MCP server not found"));
      return;
    }
    // setPrincipalSecret's principal_secrets rows are cascade-deleted BY SLUG
    // (deleteInstance(), instances/store.ts) — resolve it here so saveTokens/
    // saveCodeVerifier key their writes the same way every other caller does.
    const instanceSlug = await resolveInstanceSlug(instanceUuid);
    if (!instanceSlug) {
      res.status(404).type("html").send(page("Error", "Agent not found"));
      return;
    }

    try {
      const provider = makeMcpOAuthProvider({ instanceUuid, instanceSlug, conversationId: pending.conversationId, serverSlug, config: server.config });
      // The oauth_states row is already consumed above; seed the provider's
      // storedState() with it so the SDK's own CSRF check (storedState ===
      // callbackState) passes.
      provider.setStoredState(state);
      await auth(provider, { serverUrl: server.url, authorizationCode: code, callbackState: state });
      res.type("html").send(page(`${server.name} connected ✅`, "Return to the chat and continue."));
    } catch (err) {
      // The token-exchange failure detail names the authorization server and its
      // error — never render it to whoever holds the callback URL. Log it
      // server-side instead and show the browser a generic message.
      mcpLog.warn("mcp", `oauth callback failed for server '${serverSlug}': ${errMsg(err)}`);
      res.status(502).type("html").send(page("Error", "Could not complete the connection. Please try again."));
    }
  }
}
