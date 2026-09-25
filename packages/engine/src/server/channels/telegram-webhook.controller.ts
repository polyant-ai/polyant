// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, timingSafeEqual } from "node:crypto";
import { Body, Controller, Headers, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../../auth/decorators/public.decorator.js";
import { channelManager } from "../../channels/channel-manager.js";
import type { TelegramAdapter } from "../../channels/adapters/telegram/index.js";
import { getChannelConfig } from "../../instances/channels.store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";

@Controller("webhooks/telegram")
export class TelegramWebhookController {
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post(":instanceSlug")
  @HttpCode(200)
  async receive(
    @Param("instanceSlug") instanceSlug: string,
    @Headers("x-telegram-bot-api-secret-token") secret: string | undefined,
    @Body() update: unknown,
  ): Promise<{ status: string }> {
    const slug = asInstanceSlug(instanceSlug);
    const [id, channel] = await Promise.all([resolveInstanceId(slug), getChannelConfig(slug, "telegram")]);
    const adapter = channelManager.getAdapter(slug, "telegram") as TelegramAdapter | undefined;
    const expected = createHash("sha256").update(adapter?.webhookSecret ?? "").digest();
    const received = createHash("sha256").update(secret ?? "").digest();
    if (!id || !channel?.enabled || !adapter || !secret || !timingSafeEqual(expected, received)) {
      throw new NotFoundException("Telegram webhook unavailable");
    }
    if (typeof update !== "object" || update === null || typeof (update as { update_id?: unknown }).update_id !== "number") {
      throw new NotFoundException("Telegram webhook unavailable");
    }
    await adapter.handleInbound(update as Parameters<TelegramAdapter["handleInbound"]>[0]);
    return { status: "accepted" };
  }
}
