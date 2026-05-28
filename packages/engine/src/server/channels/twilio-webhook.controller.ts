// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Post, Param, Headers, Body, Req, HttpCode, NotFoundException, ForbiddenException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../../auth/decorators/public.decorator.js";
import { getChannelConfig } from "../../instances/channels.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { channelManager } from "../../channels/channel-manager.js";
import type { WhatsAppAdapter } from "../../channels/adapters/whatsapp/index.js";

interface TwilioWebhookBody {
  MessageSid: string;
  From: string;
  To: string;
  Body: string;
  ProfileName?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  MediaUrl1?: string;
  MediaContentType1?: string;
}

@Controller("webhooks/twilio")
export class TwilioWebhookController {
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Public()
  @Post(":instanceSlug/whatsapp")
  @HttpCode(200)
  async handleWhatsAppWebhook(
    @Param("instanceSlug") instanceSlug: string,
    @Headers("x-twilio-signature") signature: string,
    @Body() body: TwilioWebhookBody,
    @Req() req: Request,
  ): Promise<string> {
    // 1. Resolve instance
    const instanceId = await resolveInstanceId(instanceSlug);
    if (!instanceId) throw new NotFoundException(`Instance "${instanceSlug}" not found`);

    // 2. Load channel config
    const channelConfig = await getChannelConfig(instanceSlug, "whatsapp");
    if (!channelConfig || !channelConfig.enabled) {
      throw new NotFoundException(`WhatsApp channel not configured for "${instanceSlug}"`);
    }

    // 3. Get the active adapter
    const instanceMap = (channelManager as any).adapters.get(instanceSlug) as Map<string, WhatsAppAdapter> | undefined;
    const adapter = instanceMap?.get("whatsapp") as WhatsAppAdapter | undefined;
    if (!adapter) {
      throw new NotFoundException(`WhatsApp adapter not active for "${instanceSlug}"`);
    }

    // 4. Validate Twilio signature
    // Use the full URL from the request so it matches what Twilio signed against
    // (critical when behind proxies like ngrok)
    const webhookUrl = this.getFullUrl(req);
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params[key] = value;
    }

    const isValid = adapter.validateSignature(signature || "", webhookUrl, params);
    if (!isValid) {
      console.warn(`[whatsapp] Invalid Twilio signature for instance "${instanceSlug}" (url: ${webhookUrl})`);
      throw new ForbiddenException("Invalid Twilio signature");
    }

    // 5. Strip whatsapp: prefix from From
    const from = body.From?.replace(/^whatsapp:/, "") || "";

    // 6. Process inbound message (fire-and-forget to avoid Twilio timeout)
    // Note: the pipeline uses instanceId as slug (not UUID) — pass the slug
    // Collect media URLs (Twilio sends MediaUrl0, MediaUrl1, ...)
    const mediaItems: Array<{ url: string; contentType: string }> = [];
    const numMedia = parseInt(body.NumMedia ?? "0", 10);
    for (let i = 0; i < numMedia; i++) {
      const url = (body as unknown as Record<string, string>)[`MediaUrl${i}`];
      const contentType = (body as unknown as Record<string, string>)[`MediaContentType${i}`] ?? "application/octet-stream";
      if (url) mediaItems.push({ url, contentType });
    }

    adapter.handleInbound({
      from,
      body: body.Body || "",
      profileName: body.ProfileName,
      messageSid: body.MessageSid,
      instanceId: instanceSlug,
      media: mediaItems.length > 0 ? mediaItems : undefined,
    }).catch((err) =>
      // Pass the user-controlled slug as a separate argument so it is never
      // treated as part of the format string (CodeQL js/tainted-format-string).
      console.error("[whatsapp] Error processing inbound for instance:", instanceSlug, err),
    );

    // 7. Return empty TwiML response immediately
    return "<Response/>";
  }

  /** Reconstruct the full URL as seen by the external caller (Twilio).
   *  Honors X-Forwarded-Proto / X-Forwarded-Host set by reverse proxies (ngrok, Render, etc). */
  private getFullUrl(req: Request): string {
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
    const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "localhost";
    return `${proto}://${host}${req.originalUrl}`;
  }
}
