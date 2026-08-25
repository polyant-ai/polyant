// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Post, Param, Headers, Body, Req, HttpCode, NotFoundException, ForbiddenException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../../auth/decorators/public.decorator.js";
import { getChannelConfig, resolveWhatsAppAuthMode } from "../../instances/channels.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { channelManager } from "../../channels/channel-manager.js";
import type { WhatsAppAdapter } from "../../channels/adapters/whatsapp/index.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { sanitizeForLog } from "../../utils/create-logger.js";

/** Twilio caps a single inbound MMS at 10 media attachments. */
const MAX_TWILIO_MEDIA = 10;

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

/**
 * Constant-time comparison of two secrets. `timingSafeEqual` throws on a
 * length mismatch and the length itself would leak, so both sides are hashed
 * to a fixed 32 bytes first.
 */
function secretsMatch(expected: string, received: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b);
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
    const { config, adapter } = await this.resolveActiveChannel(instanceSlug);

    // A channel authenticated by path secret must not be reachable here: a
    // 404 (not 403) keeps the credential mode of a slug from leaking to an
    // unauthenticated caller.
    if (resolveWhatsAppAuthMode(config) !== "authToken") {
      throw new NotFoundException(`WhatsApp channel not configured for "${instanceSlug}"`);
    }

    // Use the full URL from the request so it matches what Twilio signed against
    // (critical when behind proxies like ngrok)
    const webhookUrl = this.getFullUrl(req);
    // Twilio signs EVERY POST parameter it sends, so an allowlist here is not an
    // option: dropping one unknown-but-signed field (Twilio adds them over time)
    // would make every webhook fail validation. Instead we never write a
    // body-derived property name ourselves — `Object.fromEntries` defines own
    // data properties, so a `__proto__` entry lands as a plain key (exactly as
    // Twilio hashed it) instead of retargeting the prototype chain.
    const params: Record<string, string> = Object.fromEntries(
      Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );

    const isValid = adapter.validateSignature(signature || "", webhookUrl, params);
    if (!isValid) {
      console.warn(`[whatsapp] Invalid Twilio signature for instance "${sanitizeForLog(instanceSlug)}" (url: ${sanitizeForLog(webhookUrl)})`);
      throw new ForbiddenException("Invalid Twilio signature");
    }

    return this.dispatchInbound(instanceSlug, adapter, body);
  }

  /**
   * Inbound for channels holding a Twilio API Key instead of the account Auth
   * Token. Twilio signs webhooks with the Auth Token only, so authenticity is
   * established by a server-generated secret in the path.
   *
   * Accepted cost: the secret appears in reverse-proxy access logs. Twilio
   * messaging webhooks cannot carry custom headers, so a path segment is the
   * only channel available; rotation is the mitigation.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Public()
  @Post(":instanceSlug/whatsapp/:webhookSecret")
  @HttpCode(200)
  async handleWhatsAppWebhookWithSecret(
    @Param("instanceSlug") instanceSlug: string,
    @Param("webhookSecret") webhookSecret: string,
    @Body() body: TwilioWebhookBody,
  ): Promise<string> {
    const { config, adapter } = await this.resolveActiveChannel(instanceSlug);

    if (resolveWhatsAppAuthMode(config) !== "apiKey") {
      throw new NotFoundException(`WhatsApp channel not configured for "${instanceSlug}"`);
    }

    const expected = typeof config.webhookSecret === "string" ? config.webhookSecret : "";
    if (!expected || !secretsMatch(expected, webhookSecret)) {
      // Slug only — never the secret, never the path.
      console.warn("[whatsapp] Invalid webhook secret for instance:", instanceSlug);
      throw new ForbiddenException("Invalid webhook credentials");
    }

    return this.dispatchInbound(instanceSlug, adapter, body);
  }

  /** Resolve the instance, its stored WhatsApp config and the running adapter. */
  private async resolveActiveChannel(
    instanceSlug: string,
  ): Promise<{ config: Record<string, unknown>; adapter: WhatsAppAdapter }> {
    const instanceId = await resolveInstanceId(asInstanceSlug(instanceSlug));
    if (!instanceId) throw new NotFoundException(`Instance "${instanceSlug}" not found`);

    const channelConfig = await getChannelConfig(asInstanceSlug(instanceSlug), "whatsapp");
    if (!channelConfig || !channelConfig.enabled) {
      throw new NotFoundException(`WhatsApp channel not configured for "${instanceSlug}"`);
    }

    const instanceMap = (channelManager as any).adapters.get(instanceSlug) as Map<string, WhatsAppAdapter> | undefined;
    const adapter = instanceMap?.get("whatsapp") as WhatsAppAdapter | undefined;
    if (!adapter) {
      throw new NotFoundException(`WhatsApp adapter not active for "${instanceSlug}"`);
    }

    return { config: channelConfig.config, adapter };
  }

  /** Hand the authenticated message to the pipeline and answer Twilio at once. */
  private dispatchInbound(instanceSlug: string, adapter: WhatsAppAdapter, body: TwilioWebhookBody): string {
    const from = body.From?.replace(/^whatsapp:/, "") || "";

    // Collect media URLs (Twilio sends MediaUrl0, MediaUrl1, ...)
    const mediaItems: Array<{ url: string; contentType: string }> = [];
    // Clamp the attacker-supplied count: NumMedia rides in on the request body, so an
    // absurd value ("999999999") would otherwise spin the loop below for that many
    // iterations. Twilio sends at most MAX_TWILIO_MEDIA attachments per message.
    const numMedia = Math.min(parseInt(body.NumMedia ?? "0", 10) || 0, MAX_TWILIO_MEDIA);
    for (let i = 0; i < numMedia; i++) {
      const url = (body as unknown as Record<string, string>)[`MediaUrl${i}`];
      const contentType = (body as unknown as Record<string, string>)[`MediaContentType${i}`] ?? "application/octet-stream";
      if (url) mediaItems.push({ url, contentType });
    }

    // Fire-and-forget so Twilio is not kept waiting for the pipeline.
    adapter.handleInbound({
      from,
      body: body.Body || "",
      profileName: body.ProfileName,
      messageSid: body.MessageSid,
      instanceId: asInstanceSlug(instanceSlug),
      media: mediaItems.length > 0 ? mediaItems : undefined,
    }).catch((err) =>
      // Pass the user-controlled slug as a separate argument so it is never
      // treated as part of the format string (CodeQL js/tainted-format-string).
      console.error("[whatsapp] Error processing inbound for instance:", sanitizeForLog(instanceSlug), err),
    );

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
