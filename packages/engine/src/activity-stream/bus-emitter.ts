// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ActivityBus producers.
 *
 * Two entry points cover both call paths through the AI gateway:
 *
 *   1. `tapAndForwardFullStream(stream, ctx)` — wraps `chatStream().fullStream`
 *      with an async generator that forwards every chunk to the original
 *      consumer (controllers, supervisor) AND publishes live events on the
 *      ActivityBus. Tool calls are emitted in real time (started/completed),
 *      reasoning is aggregated and emitted on `step-finish`, and the final
 *      assistant text of a step is emitted likewise.
 *
 *   2. `emitFromChatResponse(response, ctx)` — for non-streaming `chat()`
 *      callers (room-engine, webhook-engine, scheduled tasks): replays the
 *      `response.steps[]` as a batch of events at the end of the call, so
 *      those turns still appear in the live feed (just not progressively).
 *
 * Both populate the spotlight payload (`argsPreview`, `resultPreview`,
 * `responsePreview`, `status`, `durationMs`, `conversationId`) so the
 * activity panel's right-hand detail card has everything it needs.
 */

import { activityBus } from "./activity-bus.js";
import {
  joinReasoning,
  truncate,
  MAX_REASONING_CHARS,
  MAX_SPOTLIGHT_CHARS,
} from "./event-formatters.js";
import type {
  EventStatus,
  FeedEvent,
  InstanceMeta,
} from "./activity-stream.types.js";
import type {
  ChatResponse,
  ChatStreamResult,
} from "../ai-gateway/types.js";
import type { ReasoningDetail } from "../conversations/schema.js";

export interface BusContext {
  instance?: InstanceMeta;
  conversationId?: string;
}

interface StepBuffer {
  reasoningBlocks: ReasoningDetail[];
  text: string;
}

/**
 * Wrap an AI SDK `fullStream` so consumers see exactly what they'd see
 * without the tap, while listeners on the ActivityBus get live events
 * derived from the stream.
 *
 * The function is intentionally tolerant of unknown chunk types — the SDK
 * occasionally adds new event variants and we don't want a runtime error
 * to break the actual chat flow.
 */
export function tapAndForwardFullStream(
  source: ChatStreamResult["fullStream"],
  ctx: BusContext,
): AsyncIterable<unknown> {
  // Outer async generator preserves the caller's contract: same chunk shape,
  // same iteration semantics, same backpressure (consumer-driven).
  return (async function* tapped() {
    const baseId = makeBaseId(ctx.conversationId);
    let stepIndex = 0;
    const stepBuffer: StepBuffer = { reasoningBlocks: [], text: "" };
    try {
      for await (const chunk of source as AsyncIterable<Record<string, unknown>>) {
        // Always forward first — never let bus emission errors block the
        // primary chat flow.
        yield chunk;

        try {
          const handler: HandleCtx = {
            ctx,
            baseId,
            stepBuffer,
            getStepIndex: () => stepIndex,
            advanceStep: () => {
              stepIndex += 1;
              stepBuffer.reasoningBlocks = [];
              stepBuffer.text = "";
            },
          };
          handleChunk(chunk, handler);
        } catch (err) {
          // The chat itself is unaffected by our bookkeeping; just log the
          // bus tap failure and keep streaming.
          console.error("[activity-bus] tap error:", err);
        }
      }
    } catch (err) {
      // Stream blew up. Surface as an error event so the spotlight can
      // render the failure, then rethrow so the caller still sees it.
      safeEmit({
        id: `${baseId}:stream-error`,
        ts: nowIso(),
        persona: "agent",
        text: err instanceof Error ? err.message : String(err),
        instance: ctx.instance,
        conversationId: ctx.conversationId,
        status: "error",
      });
      throw err;
    }
  })();
}

interface HandleCtx {
  ctx: BusContext;
  baseId: string;
  stepBuffer: StepBuffer;
  getStepIndex: () => number;
  advanceStep: () => void;
}

/**
 * Map an SDK fullStream chunk to bus events. Pure-ish: the only side-effect
 * is `safeEmit()` calls and minor mutation of the per-stream buffers.
 */
function handleChunk(chunk: Record<string, unknown>, h: HandleCtx): void {
  const type = chunk.type as string | undefined;
  switch (type) {
    case "start-step": {
      // Bump the step index when a new SDK step starts. The first step still
      // lives at index 0 — see the constructor in tapAndForwardFullStream.
      if (h.getStepIndex() !== 0 || h.stepBuffer.reasoningBlocks.length > 0 || h.stepBuffer.text.length > 0) {
        h.advanceStep();
      }
      return;
    }

    case "reasoning-delta": {
      // SDK emits reasoning text deltas. Buffer and keep them for the
      // step-finish aggregate event.
      const delta = typeof chunk.text === "string" ? chunk.text : "";
      if (delta) {
        const last = h.stepBuffer.reasoningBlocks[h.stepBuffer.reasoningBlocks.length - 1];
        if (last && last.type === "text" && !last.signature) {
          last.text += delta;
        } else {
          h.stepBuffer.reasoningBlocks.push({ type: "text", text: delta });
        }
      }
      return;
    }

    case "reasoning-signature": {
      const sig = typeof chunk.signature === "string" ? chunk.signature : "";
      const last = h.stepBuffer.reasoningBlocks[h.stepBuffer.reasoningBlocks.length - 1];
      if (last && last.type === "text" && sig) {
        last.signature = sig;
      }
      return;
    }

    case "redacted-reasoning": {
      h.stepBuffer.reasoningBlocks.push({ type: "redacted", data: "" });
      return;
    }

    case "text-delta": {
      const delta = typeof chunk.text === "string" ? chunk.text : "";
      if (delta) h.stepBuffer.text += delta;
      return;
    }

    case "tool-call":
    case "tool-result":
      // Tool lifecycle events are emitted by the supervisor's audit
      // wrapper, which is the only place that owns the real wall-clock
      // start/end of each invocation. The SDK chunks here are
      // intentionally ignored to avoid double events.
      return;

    case "finish-step": {
      // Emit the aggregated reasoning of the step (if any) and — only for
      // terminal steps — the assistant text. Steps that finish with
      // `tool-calls` are intermediate (the model is delegating to a tool
      // and another step will follow): their `text` is typically junk like
      // empty strings or `"[]"` from partial tool-call serialization, so
      // we drop it. Reasoning is still interesting per-step regardless.
      const stepIndex = h.getStepIndex();
      const finishReason = typeof chunk.finishReason === "string" ? chunk.finishReason : "";

      if (h.stepBuffer.reasoningBlocks.length > 0) {
        const fullText = joinReasoning(h.stepBuffer.reasoningBlocks);
        if (fullText) {
          safeEmit({
            id: `${h.baseId}:s${stepIndex}:think:0`,
            ts: nowIso(),
            persona: "thinking",
            text: truncate(fullText, MAX_REASONING_CHARS),
            instance: h.ctx.instance,
            conversationId: h.ctx.conversationId,
            responsePreview: truncate(fullText, MAX_SPOTLIGHT_CHARS),
          });
        }
      }

      if (finishReason !== "tool-calls") {
        const trimmedText = h.stepBuffer.text.trim();
        if (trimmedText.length > 0) {
          safeEmit({
            id: `${h.baseId}:s${stepIndex}:text:0`,
            ts: nowIso(),
            persona: "agent",
            text: truncate(trimmedText, MAX_REASONING_CHARS),
            instance: h.ctx.instance,
            conversationId: h.ctx.conversationId,
            responsePreview: truncate(trimmedText, MAX_SPOTLIGHT_CHARS),
          });
        }
      }
      return;
    }

    default:
      // Unknown / unhandled chunk — ignore.
      return;
  }
}

/**
 * Batch-emit the equivalent FeedEvent stream for a non-streaming `chat()`
 * call. Same shape as the live tap, just delivered all at once.
 */
export function emitFromChatResponse(response: ChatResponse, ctx: BusContext): void {
  const baseId = makeBaseId(ctx.conversationId);
  if (response.steps.length === 0) return;

  for (const step of response.steps) {
    if (step.reasoning && step.reasoning.length > 0) {
      const fullText = joinReasoning(step.reasoning);
      if (fullText) {
        safeEmit({
          id: `${baseId}:s${step.index}:think:0`,
          ts: nowIso(),
          persona: "thinking",
          text: truncate(fullText, MAX_REASONING_CHARS),
          instance: ctx.instance,
          conversationId: ctx.conversationId,
          responsePreview: truncate(fullText, MAX_SPOTLIGHT_CHARS),
        });
      }
    }

    // Tool events are NOT emitted here. The supervisor's audit wrapper
    // is the canonical source: it has the real start/end timestamps for
    // each invocation, regardless of whether the call is streaming or
    // non-streaming. Replaying SDK steps at chat() return time would
    // assign every tool the same `nowIso()` (the moment chat() resolves) —
    // visually wrong on long multi-step turns.

    // Skip text on intermediate steps (those that hand off to another step
    // via tool-calls). Same reasoning as the streaming path.
    if (step.finishReason !== "tool-calls") {
      const trimmedText = step.text.trim();
      if (trimmedText.length > 0) {
        safeEmit({
          id: `${baseId}:s${step.index}:text:0`,
          ts: nowIso(),
          persona: "agent",
          text: truncate(trimmedText, MAX_REASONING_CHARS),
          instance: ctx.instance,
          conversationId: ctx.conversationId,
          responsePreview: truncate(trimmedText, MAX_SPOTLIGHT_CHARS),
        });
      }
    }
  }
}

/**
 * Heuristic: classify a tool result as success or error. Conservative — we
 * report "error" only when the indicator is unambiguous, otherwise leave
 * "success" so the spotlight pill stays positive.
 *
 * Catches:
 *   - thrown Error agents surfaced by the SDK as the `result` payload
 *   - the `{ error: "...", ... }` envelope our own tools use
 *   - explicit `isError: true` flag (Vercel AI SDK v5+ convention)
 *   - explicit `success: false` flag (Polyant tool convention)
 */
export function classifyResultStatus(result: unknown): EventStatus {
  if (result instanceof Error) return "error";
  if (result == null || typeof result !== "object") return "success";
  const r = result as Record<string, unknown>;
  if (r.isError === true) return "error";
  if (r.success === false) return "error";
  if (typeof r.error === "string" && r.error.length > 0) return "error";
  return "success";
}

/** Wrap emit so listener errors never bubble back to the producer. */
function safeEmit(evt: FeedEvent): void {
  try {
    activityBus.emitEvent(evt);
  } catch {
    // Listener mis-behaved; drop. Activity bus is purely best-effort.
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeBaseId(conversationId: string | undefined): string {
  // The conversation id alone isn't enough to disambiguate two consecutive
  // turns of the same conversation; mix in a fresh nonce so subsequent
  // event ids don't collide on the client-side dedup.
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${conversationId ?? "anon"}:${Date.now()}:${nonce}`;
}
