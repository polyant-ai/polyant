// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Post, Param, Body, Headers, HttpCode, UnauthorizedException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { timingSafeEqual } from "crypto";
import { findByWebhookToken, listEnabledDefinitions, type EventSource } from "../../webhooks/webhook-sources.store.js";
import { getRoomByInstanceId } from "../../room/room.store.js";
import { matchEvent } from "../../webhooks/webhook-matcher.js";
import { insertEvent } from "../../webhooks/webhook-backlog.store.js";
import { triggerConversation } from "../../webhooks/webhook-engine.js";
import { resolveInstanceSlug } from "../../instances/resolve-instance-id.js";
import { webhookLog } from "../../webhooks/webhook-logger.js";
import { Public } from "../../auth/decorators/public.decorator.js";
import { emitWebhook } from "../../activity-stream/emitters/emit-webhook.js";
import { resolveInstanceMeta } from "../../activity-stream/emit-helpers.js";
import type { InstanceUuid } from "../../instances/identifiers.js";

const MAX_PAYLOAD_BYTES = 65_536;

/**
 * Per-source webhook auth: the sender must present the source's `authKey`
 * (stored in the encrypted `config`) as `Authorization: Bearer <key>`.
 * Timing-safe to avoid leaking the secret through comparison timing.
 */
function bearerMatches(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authHeader.slice(7), "utf-8");
  const exp = Buffer.from(expected, "utf-8");
  return provided.length === exp.length && timingSafeEqual(provided, exp);
}

@Controller("webhooks")
export class WebhookController {
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Public()
  @Post(":webhookToken")
  @HttpCode(200)
  async receiveEvent(
    @Param("webhookToken") webhookToken: string,
    @Body() payload: Record<string, unknown>,
    @Headers("authorization") authHeader?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const safePayload = payload ?? {};
    if (JSON.stringify(safePayload).length > MAX_PAYLOAD_BYTES) {
      return { ok: false, error: "payload too large" };
    }

    const result = await findByWebhookToken(webhookToken);
    // Unknown token: stay silent and return 200 so a caller cannot probe which
    // tokens exist (tokens are 32-byte random — not enumerable regardless).
    if (!result) {
      webhookLog.warn("Webhook", `unknown token ${webhookToken.slice(0, 8)}...`);
      return { ok: true };
    }

    // Per-source auth gate. A source with an `authKey` configured requires the
    // sender to present it; no key = open, backward-compatible. ponytail: 401 on
    // mismatch aids legit-sender setup — the 401-vs-200 signal is moot because a
    // caller reaching this branch already holds a valid (unguessable) token.
    const expectedKey = typeof result.source.config.authKey === "string" ? result.source.config.authKey : "";
    if (expectedKey && !bearerMatches(authHeader, expectedKey)) {
      webhookLog.warn("Webhook", `invalid credentials for source "${result.source.name}"`);
      throw new UnauthorizedException("Invalid webhook credentials");
    }

    this.processEvent(result, safePayload).catch((err) =>
      webhookLog.error("Webhook", "processing error", err),
    );

    return { ok: true };
  }

  private async processEvent(
    result: { source: EventSource; instanceId: InstanceUuid },
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { source, instanceId } = result;
    if (!source.enabled) {
      webhookLog.info("Webhook", `source "${source.name}" disabled, dropping`);
      return;
    }

    const definitions = await listEnabledDefinitions(source.id);
    if (definitions.length === 0) {
      webhookLog.info("Webhook", `no definitions for source "${source.name}", dropping`);
      return;
    }

    const slug = await resolveInstanceSlug(instanceId);
    if (!slug) {
      webhookLog.warn("Webhook", `instance not found for ID ${instanceId}`);
      return;
    }

    const matched = await matchEvent(payload, definitions, slug);
    if (!matched) {
      webhookLog.info("Webhook", `no match for source "${source.name}", dropping`);
      return;
    }

    // Activity-stream emit: matched events only — probes and unknown payloads
    // stay silent (intentional, prevents the panel from filling with noise).
    // Fire-and-forget; payload digest is keys + size, never raw values.
    resolveInstanceMeta(slug)
      .then((instance) => {
        emitWebhook({
          sourceName: source.name,
          definitionName: matched.name,
          action: matched.action,
          payload,
          instance,
        });
      })
      .catch(() => {
        /* resolveInstanceMeta swallows internally; guard the chain */
      });

    // Route based on action type
    if (matched.action === "conversation") {
      // Trigger immediate conversation — no backlog, no Room required
      triggerConversation(instanceId, slug, matched, payload).catch((err) =>
        webhookLog.error("Webhook", `conversation trigger failed for "${matched.name}"`, err),
      );
      webhookLog.info("Webhook", `matched "${matched.name}" → triggering conversation`);
      return;
    }

    // Default: backlog action — requires Room to be enabled
    const room = await getRoomByInstanceId(instanceId);
    if (!room?.enabled) {
      webhookLog.info("Webhook", `room disabled for instance, dropping backlog event`);
      return;
    }

    const eventId = await insertEvent(instanceId, matched.id, payload);
    if (!eventId) {
      webhookLog.warn("Webhook", `backlog cap reached, dropping matched "${matched.name}"`);
      return;
    }
    webhookLog.info("Webhook", `matched "${matched.name}", backlog ID: ${eventId}`);
  }
}
