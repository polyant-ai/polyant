// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bridge hook tool executions into the conversation history sent to the model.
 *
 * Lifecycle hooks (e.g. a `conversation_start` hook that runs `lookupContact`)
 * execute tools whose result is, by default, recorded ONLY in `hook_executions`
 * telemetry + any `ctx.state` writes — it never reaches the LLM. When a turn's
 * tool results are opted into history (`tool_results_in_history_enabled`), a
 * hook's tool call+result should behave like any other tool call:
 *   - same turn: injected into the history passed to the supervisor, so the
 *     model sees what the hook's tool returned (`hookExecutionsToModelMessages`);
 *   - later turns: persisted as `StepDetail`s on the turn's assistant message, so
 *     `buildHistoryWithToolResults` replays them (`hookExecutionsToSteps`).
 *
 * Both are gated by the same per-instance flag at the call sites — this module is
 * pure (no flag check, no I/O) so it stays trivially testable.
 */

import type { ModelMessage } from "ai";
import type { StepDetail } from "../conversations/schema.js";
import { sanitizeToolCallId } from "../conversations/tool-history.js";
import type { HookExecutionSummary } from "./hook-types.js";

const NO_RESULT = "(no result recorded)";

/** A hook execution distilled to a replayable tool call+result. */
interface ReplayableHookCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: string;
}

/**
 * Only SUCCESSFUL `tool` hook executions carry a call+result worth replaying.
 * A stable `toolCallId` (`hook:<hookId>`) pairs the call with its result; the
 * `hook:` prefix also marks the provenance (a hook ran it, not the model).
 */
function replayableCalls(execs: HookExecutionSummary[]): ReplayableHookCall[] {
  return execs
    .filter((e) => e.actionType === "tool" && e.success && e.args !== undefined)
    .map((e) => ({
      toolCallId: `hook:${e.hookId}`,
      toolName: e.toolName,
      args: e.args as unknown,
      result: e.result ?? NO_RESULT,
    }));
}

/**
 * Hook tool executions → `[assistant tool-call, tool tool-result]` ModelMessages,
 * matching the AI SDK v6 wire shape used by `buildHistoryWithToolResults`. Empty
 * array when there is no replayable tool execution (caller appends nothing).
 */
export function hookExecutionsToModelMessages(execs: HookExecutionSummary[]): ModelMessage[] {
  const calls = replayableCalls(execs);
  if (calls.length === 0) return [];

  // Wire ids must match the Anthropic/Bedrock grammar; the internal `hook:<id>`
  // (kept for persistence + telemetry) carries a ':' Bedrock rejects.
  const assistantParts = calls.map((c) => ({
    type: "tool-call",
    toolCallId: sanitizeToolCallId(c.toolCallId),
    toolName: c.toolName,
    input: c.args,
  }));
  const toolParts = calls.map((c) => ({
    type: "tool-result",
    toolCallId: sanitizeToolCallId(c.toolCallId),
    toolName: c.toolName,
    output: { type: "text", value: c.result },
  }));

  // Cast through `unknown`: hand-built parts match the SDK wire shape (same as
  // buildHistoryWithToolResults), which is stricter than what we construct here.
  return [
    { role: "assistant", content: assistantParts } as unknown as ModelMessage,
    { role: "tool", content: toolParts } as unknown as ModelMessage,
  ];
}

/**
 * Hook tool executions → `StepDetail[]` to PREPEND to the turn's assistant message
 * steps, so subsequent turns replay them via `buildHistoryWithToolResults`. One
 * step per execution; `durationMs` carries the hook's measured duration.
 */
export function hookExecutionsToSteps(execs: HookExecutionSummary[]): StepDetail[] {
  return replayableCalls(execs).map((c, index) => ({
    index,
    stepType: "tool-result" as const,
    text: "",
    toolCalls: [{ toolCallId: c.toolCallId, toolName: c.toolName, args: c.args }],
    toolResults: [{ toolCallId: c.toolCallId, result: c.result }],
    finishReason: "tool-calls",
    durationMs: execs.find((e) => `hook:${e.hookId}` === c.toolCallId)?.durationMs ?? 0,
  }));
}
