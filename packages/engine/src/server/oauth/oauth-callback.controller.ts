// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../../auth/decorators/public.decorator.js";
import { setPrincipalSecret } from "../../conversations/principal-secrets.store.js";
import {
  getOAuthProvider,
  hasOAuthProvider,
  exchangeCodeForToken,
  resolveOAuthCredentials,
  oauthTokenStateKey,
  oauthRefreshStateKey,
} from "./oauth-providers.js";
import { consumeOAuthState } from "./oauth-states.store.js";
import { getOAuthAuthorizationScopes } from "./oauth-authorization-scopes.port.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { errMsg } from "../../utils/error.js";

/** Escape the 5 HTML-significant characters. `title`/`body` below can carry an
 *  attacker-controlled path segment (`providerName`) before it is validated
 *  against the registry, so every call is escaped here — one point of
 *  enforcement rather than per call site. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Minimal browser-facing page. The user lands here after authorizing. */
function page(title: string, body: string): string {
  const t = escapeHtml(title);
  const b = escapeHtml(body);
  return `<!doctype html><meta charset="utf-8"><title>${t}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center"><h2>${t}</h2><p>${b}</p></body>`;
}

// Generic OAuth callback for every provider in the registry. `state` is a
// single-use nonce mapped (via oauth_states) to the conversation + provider +
// PKCE verifier. Runs OUTSIDE a pipeline turn → direct vault write; the next
// turn reads the token from the encrypted vault.
@Controller("oauth")
export class OAuthCallbackController {
  @Public()
  @Get(":provider/callback")
  async callback(
    @Param("provider") providerName: string,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // The name may live only in a scoped registry; the state says which one.
    if (!hasOAuthProvider(providerName)) {
      res.status(404).type("html").send(page("Errore", `Provider OAuth sconosciuto: ${providerName}.`));
      return;
    }
    if (!code || !state) {
      res.status(400).type("html").send(page("Errore", "Parametri OAuth mancanti (code/state)."));
      return;
    }

    // The registry the authorize link was built from, read before the state
    // is consumed. Null (the shared registry) unless a scope was recorded.
    const scope = await getOAuthAuthorizationScopes().scopeOf(state);
    // Consume the single-use state nonce → conversation + PKCE verifier. Reject
    // unknown/expired (CSRF) and a provider that doesn't match the path.
    const pending = await consumeOAuthState(state);
    if (!pending || pending.provider !== providerName) {
      res.status(400).type("html").send(page("Errore", "state OAuth non valido o scaduto. Riprova a collegare."));
      return;
    }
    const { conversationId, instanceId: slug, codeVerifier } = pending;
    const provider = getOAuthProvider(providerName, scope);
    if (!provider) {
      res.status(404).type("html").send(page("Errore", `Provider OAuth sconosciuto: ${providerName}.`));
      return;
    }

    try {
      const creds = await resolveOAuthCredentials(providerName, asInstanceSlug(slug));
      if (!creds.clientId || !creds.clientSecret) {
        res
          .status(400)
          .type("html")
          .send(page("Errore", `Credenziali OAuth non configurate per "${providerName}" su questa istanza.`));
        return;
      }
      const { accessToken, refreshToken, expiresIn } = await exchangeCodeForToken(provider, code, creds, codeVerifier);
      // Encrypted vault (NOT conversation_state) so tokens are never in the
      // cleartext, promptable state blob.
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
      await setPrincipalSecret(conversationId, slug, oauthTokenStateKey(providerName, scope), accessToken, expiresAt);
      if (refreshToken) {
        await setPrincipalSecret(conversationId, slug, oauthRefreshStateKey(providerName, scope), refreshToken, null);
      }
      res.type("html").send(page(`${providerName} collegato ✅`, "Puoi tornare alla chat e continuare."));
    } catch (err) {
      res
        .status(502)
        .type("html")
        .send(page("Connessione fallita", `Scambio token ${providerName} fallito: ${errMsg(err)}`));
    }
  }
}
