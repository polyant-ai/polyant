// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Post, Param, Req, Res, Inject, NotFoundException } from "@nestjs/common";
import type { Request, Response } from "express";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { Public } from "../../auth/decorators/public.decorator.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { resolveInstanceConfig } from "../../instances/config-resolver.js";
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

  @Public()
  @Post(":slug/jsonrpc")
  async jsonrpc(@Param("slug") slug: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.assertEnabled(slug);
    await validateInstanceApiKey(slug, req.headers["authorization"] as string | undefined);
    const handler = await this.registry.getHandler(asInstanceSlug(slug));
    // ponytail: same as agentCard — jsonRpcHandler's Router matches only "/".
    // Rewrite the path before delegating (auth/gate ordering above is preserved).
    req.url = "/";
    await jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication })(req, res, noop);
  }

  /** 404 (not 403) when disabled — does not confirm/deny instance existence. */
  private async assertEnabled(slug: string): Promise<void> {
    const cfg = await resolveInstanceConfig(asInstanceSlug(slug));
    if (!cfg.a2aEnabled) throw new NotFoundException();
  }
}
