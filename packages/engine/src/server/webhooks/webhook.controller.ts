// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Post, Param, Body, HttpCode } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { findByWebhookToken, listEnabledDefinitions } from "../../webhooks/webhook-sources.store.js";
import { getRoomByInstanceId } from "../../room/room.store.js";
import { matchEvent } from "../../webhooks/webhook-matcher.js";
import { insertEvent } from "../../webhooks/webhook-backlog.store.js";
import { triggerConversation } from "../../webhooks/webhook-engine.js";
import { resolveAgentSlug } from "../../instances/resolve-agent-id.js";
import { webhookLog } from "../../webhooks/webhook-logger.js";
import { Public } from "../../auth/decorators/public.decorator.js";
import { emitWebhook } from "../../activity-stream/emitters/emit-webhook.js";
import { resolveInstanceMeta } from "../../activity-stream/emit-helpers.js";

const MAX_PAYLOAD_BYTES = 65_536;

@Controller("webhooks")
export class WebhookController {
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Public()
  @Post(":webhookToken")
  @HttpCode(200)
  async receiveEvent(
    @Param("webhookToken") webhookToken: string,
    @Body() payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const safePayload = payload ?? {};
    if (JSON.stringify(safePayload).length > MAX_PAYLOAD_BYTES) {
      return { ok: false, error: "payload too large" };
    }

    this.processEvent(webhookToken, safePayload).catch((err) =>
      webhookLog.error("Webhook", "processing error", err),
    );

    return { ok: true };
  }

  private async processEvent(webhookToken: string, payload: Record<string, unknown>): Promise<void> {
    const result = await findByWebhookToken(webhookToken);
    if (!result) {
      webhookLog.warn("Webhook", `unknown token ${webhookToken.slice(0, 8)}...`);
      return;
    }

    const { source, agentId } = result;
    if (!source.enabled) {
      webhookLog.info("Webhook", `source "${source.name}" disabled, dropping`);
      return;
    }

    const definitions = await listEnabledDefinitions(source.id);
    if (definitions.length === 0) {
      webhookLog.info("Webhook", `no definitions for source "${source.name}", dropping`);
      return;
    }

    const slug = await resolveAgentSlug(agentId);
    if (!slug) {
      webhookLog.warn("Webhook", `instance not found for ID ${agentId}`);
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
      triggerConversation(agentId, slug, matched, payload).catch((err) =>
        webhookLog.error("Webhook", `conversation trigger failed for "${matched.name}"`, err),
      );
      webhookLog.info("Webhook", `matched "${matched.name}" → triggering conversation`);
      return;
    }

    // Default: backlog action — requires Room to be enabled
    const room = await getRoomByInstanceId(agentId);
    if (!room?.enabled) {
      webhookLog.info("Webhook", `room disabled for instance, dropping backlog event`);
      return;
    }

    const eventId = await insertEvent(agentId, matched.id, payload);
    if (!eventId) {
      webhookLog.warn("Webhook", `backlog cap reached, dropping matched "${matched.name}"`);
      return;
    }
    webhookLog.info("Webhook", `matched "${matched.name}", backlog ID: ${eventId}`);
  }
}
