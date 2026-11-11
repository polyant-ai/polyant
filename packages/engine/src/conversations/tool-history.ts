// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cross-turn tool-result replay.
 *
 * The Anthropic/OpenAI APIs are stateless: each request resends the whole
 * history. Polyant normally replays only the assistant's final TEXT
 * (`getRecentMessages`), so the model "forgets" what a tool returned in an
 * earlier turn — the raw `tool_result` lives only in that turn's request.
 *
 * When a per-instance flag opts in, this rebuilds the in-window history as
 * `ModelMessage[]` with the tool_use / tool_result blocks, in one of two modes
 * (`instances.tool_history_replay`):
 *
 * - **compact** (default) reconstructs them (truncated) from the persisted
 *   `steps`. Each assistant turn that used tools becomes two messages: an
 *   assistant message carrying the text + every `tool-call` part, then a `tool`
 *   message with one `tool-result` part per call. Every call gets a matching
 *   result (synthesised if none was persisted) so the call/result pairing the
 *   providers require always holds. Multi-step turns are flattened into one
 *   parallel-call shape — valid, and it preserves the data the model needs to
 *   remember. The rebuilt turn is not what the model was sent, so the provider's
 *   prompt cache never matches it.
 * - **exact** replays each row's messages as they were sent (`exact_replay`):
 *   the user turn with its content parts, the assistant turn step by step with
 *   whole results and its reasoning parts. The request prefix of turn N+1 is then
 *   the one turn N already sent, which the prompt cache can read. A row persisted
 *   without that data (before the agent switched mode, or a reply a hook wrote)
 *   falls back to the compact rebuild.
 */

import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { MessageRow } from "./store.js";
import type { StepDetail } from "./schema.js";
import { sanitizeToolCallId, toModelToolName } from "../utils/model-tool-wire.js";
import { currentToolName } from "../agents/tools/renamed-tools.js";
import { attachmentNote } from "../ai-gateway/vision.js";

export { sanitizeToolCallId } from "../utils/model-tool-wire.js";

export const TOOL_HISTORY_REPLAY_MODES = ["compact", "exact"] as const;
export type ToolHistoryReplay = (typeof TOOL_HISTORY_REPLAY_MODES)[number];

export function isToolHistoryReplay(value: unknown): value is ToolHistoryReplay {
  return TOOL_HISTORY_REPLAY_MODES.some((mode) => mode === value);
}

/** Max characters of a single tool result kept in replayed history. Larger
 *  results are truncated — the model gets the gist without blowing the context. */
export const MAX_REPLAYED_RESULT_CHARS = 2000;

/** Serialize + truncate a persisted tool result for replay. */
function truncateResult(result: unknown): string {
  if (result === undefined || result === null) return "(no result recorded)";
  let s: string;
  try {
    s = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    s = String(result);
  }
  if (typeof s !== "string") s = String(result);
  if (s.length > MAX_REPLAYED_RESULT_CHARS) {
    return `${s.slice(0, MAX_REPLAYED_RESULT_CHARS)}… (truncated, ${s.length} chars total)`;
  }
  return s;
}

/**
 * Rebuild chronological message rows into `ModelMessage[]`, reconstructing
 * tool_use / tool_result blocks for assistant turns that used tools. Rows
 * without tool calls (user/system/plain assistant) are passed through as
 * `{ role, content }`, identical to the text-only path.
 */
export function buildHistoryWithToolResults(rows: MessageRow[]): ModelMessage[] {
  return rows.flatMap(compactRowMessages);
}

/** The compact rebuild of one row (see the module comment). */
function compactRowMessages(row: MessageRow): ModelMessage[] {
  const steps: StepDetail[] = row.steps ?? [];
  const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);

  if (row.role !== "assistant" || toolCalls.length === 0) {
    return [{ role: row.role as "user" | "assistant" | "system", content: row.content }];
  }

  // Map every persisted result by its call id so each call gets paired.
  const resultByCallId = new Map<string, unknown>();
  for (const step of steps) {
    for (const r of step.toolResults ?? []) resultByCallId.set(r.toolCallId, r.result);
  }

  const assistantParts: unknown[] = [];
  if (row.content && row.content.trim().length > 0) {
    assistantParts.push({ type: "text", text: row.content });
  }
  // Result lookup stays keyed by the RAW persisted id; only the EMITTED id is
  // sanitized (idempotent → both sides of the pair stay equal).
  for (const tc of toolCalls) {
    assistantParts.push({
      type: "tool-call",
      toolCallId: sanitizeToolCallId(tc.toolCallId),
      // Persisted steps hold the CANONICAL tool name (`<ns>:<name>` for plugins).
      // The model side requires [a-zA-Z0-9_-]+, so present it the same way
      // buildTools does (':' → '__'); otherwise a replayed namespaced tool call
      // makes the provider reject the whole request (Bedrock hard-fails).
      // A turn stored before a tool moved into a plugin holds its old flat
      // name; the model is shown the name the tool has now.
      toolName: toModelToolName(currentToolName(tc.toolName)),
      input: tc.args,
    });
  }

  const toolParts = toolCalls.map((tc) => ({
    type: "tool-result",
    toolCallId: sanitizeToolCallId(tc.toolCallId),
    toolName: toModelToolName(currentToolName(tc.toolName)),
    output: { type: "text", value: truncateResult(resultByCallId.get(tc.toolCallId)) },
  }));

  // Cast through `unknown`: the hand-built parts match the AI SDK v6 wire shape
  // (tool-call / tool-result), which the SDK forwards to the provider. The SDK's
  // ModelMessage union is stricter than what we construct row-by-row here.
  return [
    { role: "assistant", content: assistantParts } as unknown as ModelMessage,
    { role: "tool", content: toolParts } as unknown as ModelMessage,
  ];
}

// ---------------------------------------------------------------------------
// Exact replay
// ---------------------------------------------------------------------------

type Part = Record<string, unknown>;

/** One turn as the model received it, kept by agents on exact replay. */
export interface ExactTurn {
  /** The user message, content parts and volatile `<context>` tail included. */
  user: ModelMessage;
  /** The assistant and tool messages of every step, in order. */
  response: ModelMessage[];
  /** Fingerprint of the system prompt, tools and model the turn ran under (see `requestPrefixKey`). */
  prefixKey: string;
}

/**
 * The prefix fingerprint of the turn each replayed assistant message came from,
 * keyed by the message object `buildExactHistory` returned. Read by
 * `withoutStaleReasoning`, which runs once the request's own fingerprint is
 * known (the supervisor builds the system prompt and tools after the history).
 */
const turnPrefixKeys = new WeakMap<object, string>();

function partsOf(message: ModelMessage): Part[] | undefined {
  return Array.isArray(message.content) ? (message.content as Part[]) : undefined;
}

function isReasoningPart(part: Part): boolean {
  return part.type === "reasoning" || part.type === "reasoning-file";
}

/** `message` without its reasoning parts; undefined when nothing else is left. */
function withoutReasoningParts(message: ModelMessage): ModelMessage | undefined {
  const parts = partsOf(message);
  if (!parts || !parts.some(isReasoningPart)) return message;
  const kept = parts.filter((p) => !isReasoningPart(p));
  return kept.length > 0 ? ({ ...message, content: kept } as unknown as ModelMessage) : undefined;
}

/**
 * The persisted tool names and call ids, presented the way the compact rebuild
 * presents them. Both mappings are idempotent on what the model was sent, so a
 * turn stored under today's names replays byte for byte.
 */
function withCurrentToolNames(message: ModelMessage): ModelMessage {
  const parts = partsOf(message);
  if (!parts) return message;
  let changed = false;
  const mapped = parts.map((part) => {
    if (part.type !== "tool-call" && part.type !== "tool-result") return part;
    const toolName = typeof part.toolName === "string" ? toModelToolName(currentToolName(part.toolName)) : part.toolName;
    const toolCallId = typeof part.toolCallId === "string" ? sanitizeToolCallId(part.toolCallId) : part.toolCallId;
    if (toolName === part.toolName && toolCallId === part.toolCallId) return part;
    changed = true;
    return { ...part, toolName, toolCallId };
  });
  return changed ? ({ ...message, content: mapped } as unknown as ModelMessage) : message;
}

/** Every tool call of the turn has a result, and every result answers a call of the turn. */
function toolCallsPaired(messages: ModelMessage[]): boolean {
  const calls = new Set<unknown>();
  const results = new Set<unknown>();
  for (const message of messages) {
    for (const part of partsOf(message) ?? []) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type === "tool-result") results.add(part.toolCallId);
    }
  }
  return calls.size === results.size && [...calls].every((id) => results.has(id));
}

function isStoredMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as { role?: unknown; content?: unknown };
  return typeof m.role === "string" && (typeof m.content === "string" || Array.isArray(m.content));
}

/**
 * The row's messages exactly as sent, or undefined when the row carries none or
 * they cannot be replayed safely (wrong roles for the row, a tool call without
 * its result): the caller then rebuilds the row compactly.
 */
function exactRowMessages(row: MessageRow, keepReasoning: boolean): ModelMessage[] | undefined {
  const stored = row.exactReplay?.messages;
  if (!Array.isArray(stored) || stored.length === 0 || !stored.every(isStoredMessage)) return undefined;
  const rolesFit =
    row.role === "user"
      ? stored.length === 1 && stored[0].role === "user"
      : row.role === "assistant" && stored.every((m) => m.role === "assistant" || m.role === "tool");
  if (!rolesFit || !toolCallsPaired(stored)) return undefined;

  const out: ModelMessage[] = [];
  for (const message of stored) {
    const replayed = keepReasoning ? message : withoutReasoningParts(message);
    if (replayed) out.push(withCurrentToolNames(replayed));
  }
  const prefixKey = row.exactReplay?.prefixKey;
  if (keepReasoning && prefixKey) {
    for (const message of out) if (message.role === "assistant") turnPrefixKeys.set(message, prefixKey);
  }
  return out;
}

/**
 * Rebuild chronological rows into the messages they were sent as (see the
 * module comment). Rows without exact data are rebuilt compactly.
 *
 * `keepReasoning` false drops every replayed reasoning part. The caller passes
 * it when the window no longer starts where the conversation does: a signed
 * thinking block is bound to everything before it, so once leading turns are
 * cut from the window no replayed block would be accepted (Anthropic rejects a
 * block whose prefix changed, or drops it, depending on the account).
 */
export function buildExactHistory(rows: MessageRow[], { keepReasoning }: { keepReasoning: boolean }): ModelMessage[] {
  return rows.flatMap((row) => exactRowMessages(row, keepReasoning) ?? compactRowMessages(row));
}

/**
 * Drop the reasoning parts of replayed turns that ran under a different prefix
 * than the current request: another system prompt (an edited agent, a one-shot
 * webhook context, a hook's injected context), another tool set or another
 * model. Their signed thinking blocks would be refused. Turns run under the
 * current prefix keep theirs: this choice is the same on every later request,
 * so the replayed history stays append-only.
 *
 * Returns `history` itself when nothing changed, so a history without exact
 * turns reaches the provider untouched.
 */
export function withoutStaleReasoning(history: ModelMessage[], currentPrefixKey: string): ModelMessage[] {
  let changed = false;
  const out: ModelMessage[] = [];
  for (const message of history) {
    const key = turnPrefixKeys.get(message);
    if (key === undefined || key === currentPrefixKey) {
      out.push(message);
      continue;
    }
    const kept = withoutReasoningParts(message);
    if (kept !== message) changed = true;
    if (kept) out.push(kept);
  }
  return changed ? out : history;
}

/**
 * Fingerprint of what a thinking block is bound to besides the messages: the
 * system prompt as the provider receives it (inline system messages folded in,
 * as the gateway does), the set of tools, and the model.
 */
export function requestPrefixKey(input: {
  system: string;
  messages: ModelMessage[];
  tools: Record<string, { description?: unknown }>;
  provider?: string;
  model?: string;
}): string {
  const system = [input.system, ...input.messages.filter((m) => m.role === "system").map((m) => String(m.content))]
    .filter(Boolean)
    .join("\n\n");
  const tools = Object.keys(input.tools)
    .sort()
    .map((name) => [name, typeof input.tools[name].description === "string" ? input.tools[name].description : ""]);
  return createHash("sha256")
    .update(JSON.stringify([input.provider ?? "", input.model ?? "", system, tools]))
    .digest("hex");
}

/**
 * The user message to persist for exact replay: as sent, with each image or
 * file part replaced by the note a text-only model is given in its place. The
 * bytes are not kept in the conversation table, so the first replay of a turn
 * that carried one differs from what was sent once; later replays agree.
 */
export function toExactUserMessage(message: ModelMessage): ModelMessage {
  const parts = partsOf(message);
  if (!parts) return message;
  const kept = parts.map((part) =>
    part.type === "image" || part.type === "file" ? { type: "text", text: attachmentNote(part.mediaType) } : part,
  );
  return { ...message, content: kept } as unknown as ModelMessage;
}
