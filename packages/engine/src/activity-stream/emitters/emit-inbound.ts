// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Emit a `category: "inbound"` event when a user message reaches the
 * pipeline, before the supervisor runs.
 */

import type { FeedEvent, InstanceMeta } from "../activity-stream.types.js";
import { truncate } from "../event-formatters.js";
import { makeEventId, nowIso, safeEmit } from "../emit-helpers.js";

const SUMMARY_CHARS = 80;
const PREVIEW_CHARS = 600;

export interface InboundInput {
  channelType: string;       // "telegram" | "whatsapp" | "slack" | "web" | …
  channelId: string;
  /** Display name of the sender when known. Never the raw phone/email. */
  sender?: string;
  /** Scheduled task display name. Populated only when channelType === "scheduled". */
  taskName?: string;
  /** User-typed text. */
  text: string;
  /** The kinds of the files that came with the message, when any. */
  attachmentKinds?: string[];
  conversationId: string;
  instance?: InstanceMeta;
}

export function emitInbound(input: InboundInput): void {
  const trimmed = (input.text ?? "").trim();
  const kinds = input.attachmentKinds?.length ? input.attachmentKinds : undefined;
  const summary = trimmed.length > 0 ? trimmed : kinds ? `[${kinds.join(", ")}]` : "(nessun testo)";
  const evt: FeedEvent = {
    id: makeEventId("inbound", input.conversationId),
    ts: nowIso(),
    persona: "agent",
    category: "inbound",
    text: `${input.channelType}: ${truncate(summary, SUMMARY_CHARS)}`,
    status: "success",
    responsePreview: trimmed ? truncate(trimmed, PREVIEW_CHARS) : undefined,
    attachmentKinds: kinds,
    conversationId: input.conversationId,
    instance: input.instance,
    channel: {
      type: input.channelType,
      id: input.channelId,
      sender: input.sender,
      taskName: input.taskName,
    },
  };
  safeEmit(evt);
}
