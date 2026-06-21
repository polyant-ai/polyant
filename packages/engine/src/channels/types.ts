// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChannelType } from "../instances/channels.store.js";
import type { AgentSlug } from "../instances/identifiers.js";

/**
 * Provenance tag for any message flowing through the pipeline.
 *
 * Two related but DISTINCT types live in the codebase:
 *
 * - `MessageChannelType` (this file) — the WIDE/open set: every possible
 *   source of an {@link IncomingMessage}. Includes `"web"` (REST API),
 *   `"scheduled"` (cron), `"room"` (internal event-driven) which have no
 *   per-instance stored credentials and are NOT API-configurable.
 *
 * - `ChannelType` (from `instances/channels.store.ts`) — the NARROW/closed
 *   set: only channels with a config row in `instance_channels`, validated
 *   by Zod and exposed via the management API (`PUT/DELETE
 *   /api/instances/:slug/channels/:type`). Today: telegram, slack, whatsapp.
 *
 * Adding a new API-configurable channel: extend `CHANNEL_TYPES` in
 * `instances/channels.store.ts` — this union automatically widens.
 *
 * Adding a new non-API channel (e.g. a new internal trigger source):
 * extend the union of literals below.
 */
export type MessageChannelType = ChannelType | "web" | "scheduled" | "room";

/**
 * Metadata carried on an IncomingMessage when this turn originates from
 * another instance via the in-process `agent` channel. Lets the supervisor
 * and analytics layer link the child trace to its caller (callerSlug +
 * callerConversationId) and enforce recursion bounds (depth).
 */
export interface AgentCallMetadata {
  callerSlug: string;
  callerConversationId: string;
  parentTraceId?: string;
  depth: number;
}

/** Max single outbound chunk length per channel (used to split long replies). */
export const CHANNEL_MAX_LENGTH: Record<"telegram" | "slack" | "whatsapp", number> = {
  telegram: 4000,
  slack: 3900,
  // WhatsApp app supports ~4096 chars, but Twilio's Programmable Messaging
  // API rejects body > 1600 with error 21617 ("concatenated message body
  // exceeds the 1600 character limit"). Cap below the API limit so chunks
  // always fit; splitMessage() takes care of paragraph-aware splitting.
  // Ref: https://www.twilio.com/docs/errors/21617
  whatsapp: 1600,
};

/** Metadata key used to override the auto-generated conversationId in the pipeline. */
export const METADATA_CONVERSATION_ID_OVERRIDE = "conversationIdOverride";

export interface IncomingMessage {
  /** Channel this message came from */
  channelType: MessageChannelType;

  /** Channel-specific conversation/chat ID */
  channelId: string;

  /** Agent ID (determines which workspace/personality to use) */
  agentId: AgentSlug;

  /** User display name (when available) */
  userName?: string;

  /** Message text content */
  text: string;

  /** Attachments (images, files, etc.) */
  attachments?: Attachment[];

  /** Channel-specific metadata */
  metadata: Record<string, unknown>;
}

export interface OutgoingMessage {
  /** Response text */
  text: string;

  /** Optional structured attachments */
  attachments?: Attachment[];

  /** Optional public media URL(s) to deliver alongside the text (e.g. a PDF or
   *  image). Channel adapters that support media (e.g. WhatsApp/Twilio) attach
   *  it; others ignore it. */
  mediaUrl?: string | string[];

  /** Tool calls made during the response (for observability) */
  toolCalls?: Array<{ name: string; args?: Record<string, unknown>; durationMs?: number }>;

  /** Token usage (for observability) */
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface Attachment {
  type: "image" | "file" | "audio" | "video";
  url?: string;
  data?: Buffer;
  mimeType?: string;
  fileName?: string;
}

export type MessageHandler = (msg: IncomingMessage, signal?: AbortSignal) => Promise<OutgoingMessage>;

export interface StreamOutgoingMessage {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<unknown>;
  completed: Promise<{
    text: string;
    /** Post-LLM hook outcomes (response_generated + response_sent), for live SSE rendering. */
    hookExecutions?: import("../hooks/hook-types.js").HookExecutionSummary[];
  }>;
  /**
   * Stable identifiers for the persisted assistant turn, known synchronously when
   * the stream is created (the assistant message UUID is pre-generated). Lets a
   * first-party SSE consumer echo them (e.g. in the `done` event) so the client
   * can later fetch the per-message debug payload without ordinal-matching.
   */
  meta?: { conversationId: string; messageId: string };
  /** Pre-LLM hook outcomes (conversation_start + message_received), known when the stream is created. */
  hookExecutions?: import("../hooks/hook-types.js").HookExecutionSummary[];
}

export type StreamMessageHandler = (msg: IncomingMessage, signal?: AbortSignal) => Promise<StreamOutgoingMessage>;

export interface ChannelAdapter {
  /** Unique channel name */
  name: MessageChannelType;

  /** Initialize the adapter (connect, start polling/webhooks) */
  initialize(onMessage: MessageHandler): Promise<void>;

  /** Send a message to a specific channel/chat */
  sendMessage(channelId: string, msg: OutgoingMessage): Promise<void>;

  /**
   * Send a structured template (implemented only by adapters that support it,
   * e.g. WhatsApp/Twilio Content API). Returns the provider-specific message id.
   */
  sendTemplate?(
    channelId: string,
    contentSid: string,
    variables: Record<string, string>,
  ): Promise<string>;

  /**
   * Fetch the rendered body of a template, with placeholders substituted.
   * Implemented only by adapters that support templates (currently
   * WhatsApp/Twilio). Returns the plain-text body that the user sees on the
   * channel — used to persist a meaningful message in conversation history.
   * Throws on transport / parsing failure; the caller decides the fallback.
   */
  getTemplateBody?(
    contentSid: string,
    variables: Record<string, string>,
  ): Promise<string>;

  /**
   * Request the channel to display a "typing" indicator on behalf of the bot
   * for a recent inbound message. For WhatsApp (Twilio) `messageSid` is the
   * inbound message SID; for Telegram it is ignored (uses `sendChatAction`).
   * Fire-and-forget: errors should be logged by the adapter, not propagated.
   */
  sendTyping?(channelId: string, messageSid?: string): Promise<void>;

  /** Gracefully shut down the adapter */
  shutdown(): Promise<void>;
}
