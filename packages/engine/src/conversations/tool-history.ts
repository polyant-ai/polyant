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
 * `ModelMessage[]` with the tool_use / tool_result blocks reconstructed
 * (truncated) from the persisted `steps`, so the model retains tool outputs
 * across turns.
 *
 * Each assistant turn that used tools becomes two messages: an assistant message
 * carrying the text + every `tool-call` part, then a `tool` message with one
 * `tool-result` part per call. Every call gets a matching result (synthesised if
 * none was persisted) so the call/result pairing the providers require always
 * holds. Multi-step turns are flattened into one parallel-call shape — valid, and
 * it preserves the data the model needs to remember.
 */

import type { ModelMessage } from "ai";
import type { MessageRow } from "./store.js";
import type { StepDetail } from "./schema.js";

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
  const out: ModelMessage[] = [];

  for (const row of rows) {
    const steps: StepDetail[] = row.steps ?? [];
    const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);

    if (row.role !== "assistant" || toolCalls.length === 0) {
      out.push({
        role: row.role as "user" | "assistant" | "system",
        content: row.content,
      });
      continue;
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
    for (const tc of toolCalls) {
      assistantParts.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.args,
      });
    }

    const toolParts = toolCalls.map((tc) => ({
      type: "tool-result",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      output: { type: "text", value: truncateResult(resultByCallId.get(tc.toolCallId)) },
    }));

    // Cast through `unknown`: the hand-built parts match the AI SDK v6 wire shape
    // (tool-call / tool-result), which the SDK forwards to the provider. The SDK's
    // ModelMessage union is stricter than what we construct row-by-row here.
    out.push({ role: "assistant", content: assistantParts } as unknown as ModelMessage);
    out.push({ role: "tool", content: toolParts } as unknown as ModelMessage);
  }

  return out;
}
