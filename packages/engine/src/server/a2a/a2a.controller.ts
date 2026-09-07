// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Post, Param, Req, Res, Inject, NotFoundException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { Public } from "../../auth/decorators/public.decorator.js";
import { a2aLog } from "./a2a-logger.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { resolveInstanceConfig, type InstanceConfig } from "../../instances/config-resolver.js";
import { validateInstanceApiKey } from "../openai/instance-api-key-auth.js";
import { A2aHandlerRegistry } from "./a2a-handler.registry.js";

const noop = (): void => {};

/**
 * A2A inbound HTTP bridge. Thin: routing, the a2a_enabled gate (404 when off —
 * does not reveal instance existence), per-instance API-key auth on JSON-RPC,
 * then delegate to the SDK's Express middlewares via the per-slug handler.
 * Uses `@Res()` so the SDK middleware owns the JSON-RPC/SSE response body
 * (mirrors instance-chat-stream.controller.ts).
 */
@Controller("a2a")
export class A2aController {
  /** Slugs already warned about (auth-off exposure) — one line per slug per process. */
  private readonly warnedUnauthenticated = new Set<string>();

  constructor(@Inject(A2aHandlerRegistry) private readonly registry: A2aHandlerRegistry) {}

  /** Discovery stays unauthenticated (no API-key check) — only the a2a_enabled gate applies. */
  @Public()
  @Get(":slug/.well-known/agent-card.json")
  async agentCard(@Param("slug") slug: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.assertEnabled(slug);
    const handler = await this.registry.getHandler(asInstanceSlug(slug));
    // ponytail: the SDK's agentCardHandler returns a Router whose real handler is
    // bound to the EXACT path "/", but the live req.url is /a2a/:slug/... — it
    // never matches and the response hangs. Rewrite to "/"; the SDK reads
    // method/body/headers (not the path), so delegating the whole request is safe.
    req.url = "/";
    await agentCardHandler({ agentCardProvider: handler })(req, res, noop);
  }

  /**
   * Rate limit mirrors the sibling `POST /v1/chat/completions` window
   * (openai.controller.ts): both are `@Public()` LLM entry points whose only
   * gate is `validateInstanceApiKey`, which returns SILENTLY when the agent's
   * `authEnabled` is false — so without a throttle an operator who enables A2A
   * with auth off exposes an unmetered LLM spend endpoint.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(":slug/jsonrpc")
  async jsonrpc(@Param("slug") slug: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const cfg = await this.assertEnabled(slug);
    this.warnIfUnauthenticated(slug, cfg.authEnabled);
    await validateInstanceApiKey(slug, req.headers["authorization"] as string | undefined);
    const handler = await this.registry.getHandler(asInstanceSlug(slug));
    // ponytail: same as agentCard — jsonRpcHandler's Router matches only "/".
    // Rewrite the path before delegating (auth/gate ordering above is preserved).
    req.url = "/";
    await jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication })(req, res, noop);
  }

  /** 404 (not 403) when disabled — does not confirm/deny instance existence. */
  private async assertEnabled(slug: string): Promise<InstanceConfig> {
    const cfg = await resolveInstanceConfig(asInstanceSlug(slug));
    if (!cfg.a2aEnabled) throw new NotFoundException();
    return cfg;
  }

  /**
   * `a2a_enabled` and `auth_enabled` are independent flags, and the Agent Card
   * faithfully advertises `securitySchemes: {}` when auth is off — so this
   * configuration is legitimate (a private network, a gateway in front) but is
   * also how an operator accidentally publishes an open LLM endpoint.
   *
   * DECISION: we still serve JSON-RPC (refusing would silently break the
   * documented "auth off = open access" contract shared with `/v1`), but the
   * exposure is no longer silent: one loud warning per slug per process, plus
   * the throttle above as the standing mitigation.
   */
  private warnIfUnauthenticated(slug: string, authEnabled: boolean): void {
    if (authEnabled || this.warnedUnauthenticated.has(slug)) return;
    this.warnedUnauthenticated.add(slug);
    a2aLog.warn(
      "A2A",
      `agent "${slug}" serves JSON-RPC with auth DISABLED — any caller that can reach this route can spend LLM tokens. ` +
        `Enable the agent's API key (auth_enabled) or restrict network access. Requests stay rate-limited to 20/min.`,
    );
  }
}
