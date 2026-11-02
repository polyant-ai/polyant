// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What becomes of the text a model writes in a step that ends with a tool call.
 *
 * A turn is a loop of steps, and a model may write text in a step that also
 * calls a tool. The reply has always been the LAST step's text (AI SDK
 * `result.text`), while a stream emits every step's text as it arrives — so the
 * same words were delivered on a streamed channel and dropped on a buffered one,
 * and the model was never told either way. An agent that sets a policy gets the
 * same treatment on every channel, and the prompt states it (see
 * `renderReplyDeliverySection`). An agent that sets none keeps the old
 * per-channel behaviour and an unchanged prompt.
 *
 * - `discard`: only the last step's text is the reply; earlier text is never
 *   delivered, not even on a stream. When the turn stops on a step that called
 *   a tool (the step limit), that step is the last and its text is the reply.
 * - `progress`: earlier text may be shown live as a progress note on a channel
 *   that streams; the reply is still the last step's text.
 * - `reply`: every step's text, in order, is the reply.
 */
export const INTERMEDIATE_TEXT_POLICIES = ["discard", "progress", "reply"] as const;
export type IntermediateTextPolicy = (typeof INTERMEDIATE_TEXT_POLICIES)[number];

export function isIntermediateTextPolicy(value: unknown): value is IntermediateTextPolicy {
  return typeof value === "string" && (INTERMEDIATE_TEXT_POLICIES as readonly string[]).includes(value);
}

/** Paragraph break placed between the texts of two steps under `reply`. */
const STEP_SEPARATOR = "\n\n";

/**
 * The reply under `reply`: each step's text as written, in order, with a
 * separator between steps that wrote any. The stream applies the same rule, so
 * whitespace and indentation reach both paths unchanged.
 */
export function joinStepTexts(steps: readonly { text?: unknown }[]): string {
  return steps
    .map((step) => (typeof step.text === "string" ? step.text : ""))
    .filter((text) => text.length > 0)
    .join(STEP_SEPARATOR);
}

/** The reply text a finished turn carries under `policy`. */
export function replyTextFor(
  policy: IntermediateTextPolicy | undefined,
  finalStepText: string,
  steps: readonly { text?: unknown }[],
): string {
  return policy === "reply" ? joinStepTexts(steps) : finalStepText;
}

interface StreamPart {
  type: string;
  id?: string;
  text?: string;
}

const TEXT_PARTS = new Set(["text-start", "text-delta", "text-end"]);
const TOOL_PARTS = new Set(["tool-input-start", "tool-call"]);

/**
 * Apply `policy` to an AI SDK full stream. `discard` holds a step's text until
 * the step ends; a step that called a tool keeps it held until the next step
 * starts, which drops it, or the turn finishes there, which delivers it. A
 * streamed channel thus delivers what a buffered one does (the last step's
 * text) at the cost of streaming the final step only once it is complete. `reply` separates the texts of successive
 * steps the way `joinStepTexts` does. Any other policy passes the stream through.
 */
export async function* applyIntermediateTextPolicy(
  source: AsyncIterable<unknown>,
  policy: IntermediateTextPolicy | undefined,
): AsyncGenerator<unknown> {
  if (policy === "discard") {
    yield* discardToolStepText(source);
    return;
  }
  if (policy === "reply") {
    yield* separateStepTexts(source);
    return;
  }
  yield* source;
}

async function* discardToolStepText(source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  let held: unknown[] = [];
  let toolStep = false;
  // Text of the last closed step that called a tool: the reply if no step follows.
  let toolStepText: unknown[] = [];
  for await (const chunk of source) {
    const part = chunk as StreamPart;
    if (part.type === "start-step") {
      held = [];
      toolStep = false;
      toolStepText = [];
      yield chunk;
    } else if (TEXT_PARTS.has(part.type)) {
      held.push(chunk);
    } else if (TOOL_PARTS.has(part.type)) {
      toolStep = true;
      yield chunk;
    } else if (part.type === "finish-step") {
      if (toolStep) toolStepText = held;
      else yield* held;
      held = [];
      yield chunk;
    } else if (part.type === "finish") {
      yield* toolStepText;
      toolStepText = [];
      yield chunk;
    } else {
      yield chunk;
    }
  }
  // A stream that ends without its finish part (an abort, a provider error)
  // still delivers the text it held, as an unfiltered stream would have.
  yield* toolStepText;
  yield* held;
}

async function* separateStepTexts(source: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  let earlierText = false;
  let textInStep = false;
  for await (const chunk of source) {
    const part = chunk as StreamPart;
    if (part.type === "start-step") {
      earlierText ||= textInStep;
      textInStep = false;
    } else if (part.type === "text-delta" && part.text) {
      if (earlierText && !textInStep) {
        yield { type: "text-delta", id: part.id, text: STEP_SEPARATOR };
      }
      textInStep = true;
    }
    yield chunk;
  }
}

/** The text deltas of a full stream, as `textStream` delivers them. */
export async function* textDeltas(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const chunk of source) {
    const part = chunk as StreamPart;
    if (part.type === "text-delta" && part.text) yield part.text;
  }
}
