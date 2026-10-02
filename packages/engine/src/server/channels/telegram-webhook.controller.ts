// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, timingSafeEqual } from "node:crypto";
import { Body, Controller, Headers, HttpCode, NotFoundException, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../../auth/decorators/public.decorator.js";
import type { TelegramAdapter } from "../../channels/adapters/telegram/index.js";
import { channelWebhookTracker, requireLiveAdapter } from "./live-adapter.js";

const UNAVAILABLE = "Telegram webhook unavailable";

@Controller("webhooks/telegram")
export class TelegramWebhookController {
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000, getTracker: channelWebhookTracker("telegram") } })
  @Post(":instanceSlug")
  @HttpCode(200)
  async receive(
    @Param("instanceSlug") instanceSlug: string,
    @Headers("x-telegram-bot-api-secret-token") secret: string | undefined,
    @Body() update: unknown,
  ): Promise<{ status: string }> {
    const { adapter } = await requireLiveAdapter<TelegramAdapter>(instanceSlug, "telegram", { message: UNAVAILABLE });
    const expected = createHash("sha256").update(adapter.webhookSecret).digest();
    const received = createHash("sha256").update(secret ?? "").digest();
    if (!secret || !timingSafeEqual(expected, received)) {
      throw new NotFoundException(UNAVAILABLE);
    }
    if (typeof update !== "object" || update === null || typeof (update as { update_id?: unknown }).update_id !== "number") {
      throw new NotFoundException(UNAVAILABLE);
    }
    await adapter.handleInbound(update as Parameters<TelegramAdapter["handleInbound"]>[0]);
    return { status: "accepted" };
  }
}
