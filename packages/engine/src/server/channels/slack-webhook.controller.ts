// SPDX-License-Identifier: AGPL-3.0-or-later

import { Body, Controller, Headers, HttpCode, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../../auth/decorators/public.decorator.js";
import type { SlackAdapter } from "../../channels/adapters/slack/index.js";
import { channelWebhookTracker, requireLiveAdapter } from "./live-adapter.js";

const UNAVAILABLE = "Slack webhook unavailable";

@Controller("webhooks/slack")
export class SlackWebhookController {
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000, getTracker: channelWebhookTracker("slack") } })
  @Post(":instanceSlug")
  @HttpCode(200)
  async receive(
    @Param("instanceSlug") instanceSlug: string,
    @Headers("x-slack-signature") signature: string | undefined,
    @Headers("x-slack-request-timestamp") timestamp: string | undefined,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ challenge: string } | { status: string }> {
    const { adapter } = await requireLiveAdapter<SlackAdapter>(instanceSlug, "slack", { message: UNAVAILABLE });
    if (!signature || !timestamp || !req.rawBody || !adapter.verifyRequest(req.rawBody, signature, timestamp)) {
      throw new NotFoundException(UNAVAILABLE);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new NotFoundException(UNAVAILABLE);
    }
    const event = body as Record<string, unknown>;
    if (event.type === "url_verification" && typeof event.challenge === "string") {
      return { challenge: event.challenge };
    }
    if (event.type !== "event_callback") return { status: "ignored" };
    void adapter.handleInbound(event).catch((error) =>
      console.error("[slack] webhook processing failed:", error),
    );
    return { status: "accepted" };
  }
}
