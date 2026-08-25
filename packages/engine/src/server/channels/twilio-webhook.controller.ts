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
import { redactWebhookPath } from "../filters/redact-webhook-path.js";

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

// Twilio caps a single inbound MMS at 10 media attachments.
const MAX_TWILIO_MEDIA = 10;

/**
 * Single client-facing message for EVERY pre-auth failure on either webhook
 * route (unknown instance, unconfigured/disabled channel, inactive adapter,
 * a mode mismatch — i.e. hitting the wrong route for the channel's
 * configured auth mode — or a wrong/missing path secret on the apiKey
 * route). NestJS puts the exception message in the response body, so
 * distinguishable messages here would let an anonymous caller with a junk
 * secret enumerate valid instance slugs and learn which have a live
 * WhatsApp channel. The real reason is logged server-side instead.
 */
export const WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE = "WhatsApp webhook not available for this instance";

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

/**
 * Twilio signs EVERY POST parameter it sends, so an allowlist here is not an
 * option: dropping one unknown-but-signed field (Twilio adds them over time)
 * would make every webhook fail validation. Instead we never write a
 * body-derived property name ourselves — `Object.fromEntries` defines own
 * data properties, so a `__proto__` entry lands as a plain key (exactly as
 * Twilio hashed it) instead of retargeting the prototype chain.
 */
export function collectSignedParams(body: TwilioWebhookBody): Record<string, string> {
  return Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * Log the real reason behind a webhook 404 without exposing it to the
 * caller — see `WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE`. `instanceSlug` is
 * request-controlled, so it is passed as a separate argument rather than
 * interpolated into the format string (CodeQL js/tainted-format-string),
 * AND sanitized (Express decodes percent-escapes in a path segment, so a
 * slug like "foo%0A[INFO] fake" arrives containing a real newline —
 * CWE-117).
 */
function logWebhookUnavailable(reason: string, instanceSlug: string): void {
  console.warn(`[whatsapp] Webhook unavailable (${reason}) for instance:`, sanitizeForLog(instanceSlug));
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

    // A channel authenticated by path secret must not be reachable here: an
    // identical 404 keeps the credential mode of a slug from leaking to an
    // unauthenticated caller (see WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE).
    if (resolveWhatsAppAuthMode(config) !== "authToken") {
      logWebhookUnavailable("wrong auth mode, expected authToken", instanceSlug);
      throw new NotFoundException(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    }

    // Use the full URL from the request so it matches what Twilio signed against
    // (critical when behind proxies like ngrok)
    const webhookUrl = this.getFullUrl(req);
    const params = collectSignedParams(body);

    const isValid = adapter.validateSignature(signature || "", webhookUrl, params);
    if (!isValid) {
      console.warn(
        "[whatsapp] Invalid Twilio signature for instance %s (url: %s)",
        sanitizeForLog(instanceSlug),
        sanitizeForLog(redactWebhookPath(webhookUrl)),
      );
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
      logWebhookUnavailable("wrong auth mode, expected apiKey", instanceSlug);
      throw new NotFoundException(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    }

    const expected = typeof config.webhookSecret === "string" ? config.webhookSecret : "";
    if (!expected || !secretsMatch(expected, webhookSecret)) {
      // Slug only — never the secret, never the path. Answers the same
      // shared 404 as every other pre-auth failure: a distinguishable 403
      // here would tell an anonymous prober "this slug exists AND has an
      // enabled API-Key-mode WhatsApp channel with a live adapter" — the
      // exact existence oracle the unified 404 exists to close. The
      // distinguishing detail (bad secret vs. unconfigured channel) is kept
      // in this server-side log line only.
      console.warn("[whatsapp] Invalid webhook secret for instance:", sanitizeForLog(instanceSlug));
      throw new NotFoundException(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    }

    return this.dispatchInbound(instanceSlug, adapter, body);
  }

  /** Resolve the instance, its stored WhatsApp config and the running adapter. */
  private async resolveActiveChannel(
    instanceSlug: string,
  ): Promise<{ config: Record<string, unknown>; adapter: WhatsAppAdapter }> {
    const instanceId = await resolveInstanceId(asInstanceSlug(instanceSlug));
    if (!instanceId) {
      logWebhookUnavailable("instance not found", instanceSlug);
      throw new NotFoundException(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    }

    const channelConfig = await getChannelConfig(asInstanceSlug(instanceSlug), "whatsapp");
    if (!channelConfig || !channelConfig.enabled) {
      logWebhookUnavailable("channel not configured or disabled", instanceSlug);
      throw new NotFoundException(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
    }

    const instanceMap = (channelManager as any).adapters.get(instanceSlug) as Map<string, WhatsAppAdapter> | undefined;
    const adapter = instanceMap?.get("whatsapp") as WhatsAppAdapter | undefined;
    if (!adapter) {
      logWebhookUnavailable("adapter not active", instanceSlug);
      throw new NotFoundException(WHATSAPP_WEBHOOK_UNAVAILABLE_MESSAGE);
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
      // treated as part of the format string (CodeQL js/tainted-format-string),
      // and sanitized so it cannot forge extra log lines (CWE-117).
      console.error("[whatsapp] Error processing inbound for instance:", sanitizeForLog(instanceSlug), err),
    );

    return "<Response/>";
  }

  /** Reconstruct the full URL as seen by the external caller (Twilio).
   *  Honors X-Forwarded-Proto / X-Forwarded-Host set by reverse proxies (ngrok, Render, etc). */
  private getFullUrl(req: Request): string {
    const proto = this.resolveForwardedProto(req);
    const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "localhost";
    return `${proto}://${host}${req.originalUrl}`;
  }

  /**
   * Clamp `X-Forwarded-Proto` to exactly `http` or `https`, falling back to
   * the connection-level `req.protocol` for anything else. A successive-proxy
   * chain sends a comma-separated list (closest hop first), so only the first
   * token is considered. Without this clamp a crafted value like
   * `user:pass@https` would be echoed straight into the URL this function
   * builds — which is both what the Twilio signature is verified against
   * (silently corrupting it, so the signature just fails to match) and what
   * gets logged on that failure (where it broke `redactWebhookPath`'s
   * userinfo-stripping branch, since the string no longer starts with a bare
   * `scheme://`).
   */
  private resolveForwardedProto(req: Request): string {
    const header = req.headers["x-forwarded-proto"];
    const raw = Array.isArray(header) ? header[0] : header;
    const firstHop = raw?.split(",")[0]?.trim().toLowerCase();
    return firstHop === "http" || firstHop === "https" ? firstHop : req.protocol;
  }
}
