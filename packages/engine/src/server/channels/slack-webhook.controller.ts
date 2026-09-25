// SPDX-License-Identifier: AGPL-3.0-or-later

import { Body, Controller, Headers, HttpCode, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../../auth/decorators/public.decorator.js";
import { channelManager } from "../../channels/channel-manager.js";
import type { SlackAdapter } from "../../channels/adapters/slack/index.js";
import { getChannelConfig } from "../../instances/channels.store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { sanitizeForLog } from "../../utils/create-logger.js";

@Controller("webhooks/slack")
export class SlackWebhookController {
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post(":instanceSlug")
  @HttpCode(200)
  async receive(
    @Param("instanceSlug") instanceSlug: string,
    @Headers("x-slack-signature") signature: string | undefined,
    @Headers("x-slack-request-timestamp") timestamp: string | undefined,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ challenge: string } | { status: string }> {
    const slug = asInstanceSlug(instanceSlug);
    const [id, channel] = await Promise.all([resolveInstanceId(slug), getChannelConfig(slug, "slack")]);
    const adapter = channelManager.getAdapter(slug, "slack") as SlackAdapter | undefined;
    if (!id || !channel?.enabled || !adapter || !signature || !timestamp || !req.rawBody ||
        !adapter.verifyRequest(req.rawBody, signature, timestamp)) {
      throw new NotFoundException("Slack webhook unavailable");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new NotFoundException("Slack webhook unavailable");
    }
    const event = body as Record<string, unknown>;
    if (event.type === "url_verification" && typeof event.challenge === "string") {
      return { challenge: event.challenge };
    }
    if (event.type !== "event_callback") return { status: "ignored" };
    void adapter.handleInbound(event).catch((error) =>
      console.error("[slack] webhook processing failed for %s:", sanitizeForLog(slug), error),
    );
    return { status: "accepted" };
  }
}
