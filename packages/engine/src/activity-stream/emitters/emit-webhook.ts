// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Emit a `category: "webhook"` event when an external webhook payload
 * matches an EventDefinition. Only matched events are surfaced — probes
 * and unknown payloads stay silent.
 */

import type { FeedEvent, InstanceMeta } from "../activity-stream.types.js";
import { truncate } from "../event-formatters.js";
import { makeEventId, nowIso, safeEmit } from "../emit-helpers.js";

const PREVIEW_CHARS = 600;

export interface WebhookInput {
  sourceName: string;
  definitionName: string;
  action: string;            // "conversation" | "backlog"
  /** Raw payload — used only to derive a key+size digest. Not echoed verbatim. */
  payload: unknown;
  conversationId?: string;
  instance?: InstanceMeta;
}

export function emitWebhook(input: WebhookInput): void {
  const digest = payloadDigest(input.payload);
  const evt: FeedEvent = {
    id: makeEventId("webhook", input.sourceName),
    ts: nowIso(),
    persona: "agent",
    category: "webhook",
    text: `${input.sourceName} → ${input.definitionName}`,
    status: "success",
    responsePreview: digest,
    conversationId: input.conversationId,
    instance: input.instance,
    webhook: {
      source: input.sourceName,
      definition: input.definitionName,
      action: input.action,
    },
  };
  safeEmit(evt);
}

/**
 * Privacy-safe summary of the webhook payload: top-level keys + total size
 * in bytes. Never the values themselves (they may carry customer PII).
 */
function payloadDigest(payload: unknown): string {
  if (payload == null || typeof payload !== "object") {
    return `payload: ${typeof payload}`;
  }
  let size: number;
  try {
    size = JSON.stringify(payload).length;
  } catch {
    size = -1;
  }
  const keys = Array.isArray(payload)
    ? `[array, ${payload.length} items]`
    : Object.keys(payload as Record<string, unknown>).slice(0, 12).join(", ");
  const sizeLabel = size >= 0 ? `${size}B` : "size unknown";
  return truncate(`${keys}\n(${sizeLabel})`, PREVIEW_CHARS);
}
