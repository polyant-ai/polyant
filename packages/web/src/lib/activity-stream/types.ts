// SPDX-License-Identifier: AGPL-3.0-or-later

export type Persona = "agent" | "thinking";

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
  /** The agent's own workspace; set by the live endpoint, absent on older payloads. */
  workspaceSlug?: string;
}

export interface ToolMeta {
  name: string;
  summary: string;
}

/** Outcome pill displayed on the spotlight card. */
export type EventStatus = "success" | "error";

export interface ChannelMeta {
  type: string;
  id: string;
  sender?: string;
  taskName?: string;
}

export interface WebhookMeta {
  source: string;
  definition: string;
  action: string;
}

export interface CronMeta {
  name: string;
  schedule: string;
  runId?: string;
  triggerType?: string;
}

export interface MemoryMeta {
  count: number;
  categories: string[];
}

export interface ConversationLifecycleMeta {
  lifecycle: "created" | "archived";
  source?: string;
  channel?: string;
}

/** Agent-to-agent handoff metadata — caller invoking another instance. */
export interface AgentHandoffMeta {
  fromInstance: InstanceMeta;
  toInstance: InstanceMeta;
  toolName: string;
  prompt: string;
  childConversationId?: string;
}

export interface FeedEvent {
  id: string;
  ts: string;
  persona: Persona;
  text: string;
  entities?: Record<string, EntityRef>;
  instance?: InstanceMeta;
  /** Present only for tool-call events. */
  tool?: ToolMeta;

  /** Explicit category for non-supervisor events; wins over the derived kind. */
  category?: EventKind;

  // ── Optional spotlight payload — server-side sanitized, capped at 600 chars
  status?: EventStatus;
  /** Single-emoji icon for the tool; falls back to the generic 🛠 in UI. */
  toolIcon?: string;
  /** Pretty-printed args (whitelist per known tool, ≤ 600 chars). */
  argsPreview?: string;
  /** Tool result preview (whitelist per known tool, ≤ 600 chars). */
  resultPreview?: string;
  /** Reasoning body or final assistant text (≤ 600 chars). */
  responsePreview?: string;
  /** Step duration. */
  durationMs?: number;
  /** Source conversation, exposed so the UI can deep-link to the transcript. */
  conversationId?: string;

  // ── Per-category metadata blocks (only one populated at a time).
  channel?: ChannelMeta;
  webhook?: WebhookMeta;
  cron?: CronMeta;
  memory?: MemoryMeta;
  conversation?: ConversationLifecycleMeta;
  handoff?: AgentHandoffMeta;
}

export const PERSONA_META: Record<Persona, { emoji: string; label: string; short: string }> = {
  agent: { emoji: "🔵", label: "Agent", short: "AG" },
  thinking: { emoji: "🧠", label: "Thinking", short: "TK" },
};

/**
 * Tailwind tokens used by the avatar background, the left-border accent and
 * the focus ring on the spotlight card. Designed to read consistently across
 * both light and dark themes.
 */
export interface PersonaAccent {
  bg: string;
  fg: string;
  border: string;
  ring: string;
}

export const PERSONA_ACCENTS: Record<Persona, PersonaAccent> = {
  agent: {
    bg: "bg-blue-500/15",
    fg: "text-blue-600 dark:text-blue-400",
    border: "border-l-blue-500",
    ring: "ring-blue-500/40",
  },
  thinking: {
    bg: "bg-violet-400/15",
    fg: "text-violet-600 dark:text-violet-400",
    border: "border-l-violet-400",
    ring: "ring-violet-400/40",
  },
};

/**
 * Visual category of an event — drives the kind pill on each row. The first
 * three are derived from the legacy fields (presence of tool, persona); the
 * remaining seven are emitted explicitly via `event.category`.
 */
export type EventKind =
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

export const KIND_ACCENTS: Record<EventKind, { bg: string; fg: string; border: string }> = {
  tool:            { bg: "bg-blue-500/15",    fg: "text-blue-600 dark:text-blue-400",       border: "border-l-blue-500" },
  thinking:        { bg: "bg-violet-500/15",  fg: "text-violet-600 dark:text-violet-400",   border: "border-l-violet-500" },
  reply:           { bg: "bg-emerald-500/15", fg: "text-emerald-600 dark:text-emerald-400", border: "border-l-emerald-500" },
  inbound:         { bg: "bg-cyan-500/15",    fg: "text-cyan-600 dark:text-cyan-400",       border: "border-l-cyan-500" },
  outbound:        { bg: "bg-teal-500/15",    fg: "text-teal-600 dark:text-teal-400",       border: "border-l-teal-500" },
  webhook:         { bg: "bg-orange-500/15",  fg: "text-orange-600 dark:text-orange-400",   border: "border-l-orange-500" },
  cron:            { bg: "bg-amber-500/15",   fg: "text-amber-700 dark:text-amber-400",     border: "border-l-amber-500" },
  memory:          { bg: "bg-fuchsia-500/15", fg: "text-fuchsia-600 dark:text-fuchsia-400", border: "border-l-fuchsia-500" },
  conversation:    { bg: "bg-slate-500/15",   fg: "text-slate-600 dark:text-slate-400",     border: "border-l-slate-500" },
  "agent-handoff": { bg: "bg-indigo-500/15",  fg: "text-indigo-600 dark:text-indigo-400",   border: "border-l-indigo-500" },
};

/** Derive the visual kind from the event payload. Explicit `category` wins. */
export function eventKind(ev: {
  persona: Persona;
  tool?: unknown;
  category?: EventKind;
}): EventKind {
  if (ev.category) return ev.category;
  if (ev.tool) return "tool";
  if (ev.persona === "thinking") return "thinking";
  return "reply";
}

/**
 * Labels passed from the page to a single activity row. Bundled here so
 * the type lives next to `FeedEvent` and can be imported by both the page
 * and the row component without a circular dependency.
 *
 * `narrative` was added when the row layout shifted from "kind pill + dump"
 * to a single narrative sentence; the legacy fields (kindLabels, bodyLabels,
 * meta…) still drive the collapsible body section.
 */
export interface RowLabels {
  openConversation: string;
  openInstance: string;
  fallbackInstance: string;
  meta: string;
  metaFields: {
    channel: string;
    sender: string;
    source: string;
    match: string;
    action: string;
    schedule: string;
    runId: string;
    trigger: string;
    gate: string;
    phase: string;
    count: string;
    categories: string;
    lifecycle: string;
  };
  kindLabels: Record<EventKind, string>;
  /** Section title used for the `responsePreview` body, per category. */
  bodyLabels: Record<EventKind, string>;
  /** Replacement body rendered for kinds whose content carries user PII. */
  privateBody: {
    inbound: string;
    reply: string;
    outbound: string;
  };
  /** Templates that turn an event into its narrative sentence. */
  narrative: import("./narrative").NarrativeLabels;
  /** Chevron tooltip / aria-label for the expand toggle. */
  expand: string;
  collapse: string;
}
