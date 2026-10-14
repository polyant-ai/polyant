// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Activity Stream — types.
 *
 * Each FeedEvent represents a single observable action of an agent:
 *   - reasoning/thinking block (`persona: "thinking"`)
 *   - tool call                (`persona: "agent"`, `tool` populated)
 *   - assistant text reply     (`persona: "agent"`, `tool` undefined)
 *
 * The `instance` block identifies which assistant produced the action
 * (icon + name + slug), and is used by the activity panel to render the
 * row header. It is optional only because the underlying join is a left
 * join — in practice it is always present for current data.
 */

export type Persona =
  /** Tool action or assistant text of a real assistant message. */
  | "agent"
  /** Reasoning/thinking block of a real assistant message. */
  | "thinking";

export interface PersonaMeta {
  emoji: string;
  label: string;
}

export const PERSONA_META: Record<Persona, PersonaMeta> = {
  agent: { emoji: "🔵", label: "Agent" },
  thinking: { emoji: "🧠", label: "Thinking" },
};

export type HubSpotObjectType = "contact" | "company" | "deal" | "ticket" | "note";

export interface EntityRef {
  label: string;
  objectType: HubSpotObjectType;
  objectId: string;
  portalUrl: string | null;
}

export interface InstanceMeta {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  /** Slug of the agent's workspace; stamped by the live endpoint so the UI can build tenant-correct links. */
  workspaceSlug?: string;
}

export interface ToolMeta {
  /** Tool name as registered (e.g. "hubspotDeal", "searchKnowledge"). */
  name: string;
  /** Short human-readable teaser of the tool args (PII-safe, never raw JSON). */
  summary: string;
}

/** Outcome pill displayed on the spotlight card. */
export type EventStatus = "success" | "error";

/**
 * Visual category of an event. The first three (`tool`, `thinking`, `reply`)
 * are derived by the UI from the legacy fields (presence of `tool`, persona)
 * and remain unset on the wire. The remaining categories are explicitly set
 * by the per-category emitters in `emitters/` for events that come from
 * sources outside the supervisor's tool/reply loop (inbound messages,
 * outbound messages, webhook activations, cron fires, memory upserts,
 * conversation lifecycle).
 */
export type EventCategory =
  | "tool"
  | "thinking"
  | "reply"
  | "inbound"
  | "outbound"
  | "webhook"
  | "cron"
  | "memory"
  | "conversation"
  | "agent-handoff";

/** Channel metadata for inbound/outbound message events. */
export interface ChannelMeta {
  type: string;          // "telegram" | "whatsapp" | "slack" | "web" | …
  id: string;            // chat / room id on the channel
  sender?: string;       // sender display name (when known) — never raw phone/email
  taskName?: string;     // populated only for type === "scheduled": the scheduled task display name
}

/** Webhook activation metadata. */
export interface WebhookMeta {
  source: string;        // webhook source name
  definition: string;    // matched event definition name
  action: string;        // "conversation" | "backlog"
}

/** Cron fire metadata. */
export interface CronMeta {
  name: string;
  schedule: string;      // cron expression or natural-language description
  runId?: string;
  triggerType?: string;  // "scheduled" | "manual"
}

/** Memory extraction batch metadata. */
export interface MemoryMeta {
  count: number;
  categories: string[];
}

/** Conversation lifecycle metadata. */
export interface ConversationLifecycleMeta {
  lifecycle: "created" | "archived";
  source?: string;       // "user" | "room" | "webhook" | "scheduled"
  channel?: string;
}

/** Agent-to-agent handoff metadata — emitted when one instance invokes another. */
export interface AgentHandoffMeta {
  /** Caller instance (duplicated in `instance` for legacy row rendering). */
  fromInstance: InstanceMeta;
  /** Target instance being invoked. */
  toInstance: InstanceMeta;
  /** Synthesized tool name (e.g. "ask_target_agent"). */
  toolName: string;
  /** Prompt passed to the target (≤ 600 chars, capped server-side). */
  prompt: string;
  /**
   * Conversation id created on the target. Optional — AgentChannelAdapter
   * currently doesn't surface it back; reserved for a future enhancement.
   */
  childConversationId?: string;
}

export interface FeedEvent {
  id: string;
  ts: string;          // ISO timestamp
  persona: Persona;
  text: string;        // descriptive text (reasoning, args teaser, or assistant reply)
  entities?: Record<string, EntityRef>; // named entities referenced in text by `{{key}}`
  instance?: InstanceMeta;
  /** Present only for tool-call events. */
  tool?: ToolMeta;

  /**
   * Explicit category for events emitted outside the supervisor's tool/reply
   * loop. Wins over the persona-derived kind on the UI when present.
   */
  category?: EventCategory;

  // ── Optional spotlight payload — server-side sanitized, capped at 600 chars
  // Drives the detail card on the right of the activity panel. Clients that
  // ignore these fields keep rendering the compact log row exactly as before.
  status?: EventStatus;
  /** Pretty-printed args (whitelist per known tool, ≤ 600 chars). */
  argsPreview?: string;
  /** Tool result preview (whitelist per known tool, ≤ 600 chars). */
  resultPreview?: string;
  /** Reasoning body or final assistant text (≤ 600 chars). */
  responsePreview?: string;
  /** Duration of the originating step. */
  durationMs?: number;
  /** Source conversation, exposed so the UI can deep-link to the transcript. */
  conversationId?: string;

  // ── Per-category metadata blocks — only one is populated at a time.
  channel?: ChannelMeta;
  webhook?: WebhookMeta;
  cron?: CronMeta;
  memory?: MemoryMeta;
  conversation?: ConversationLifecycleMeta;
  handoff?: AgentHandoffMeta;
}
