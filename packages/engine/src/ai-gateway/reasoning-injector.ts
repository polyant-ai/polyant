// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Anthropic signed-thinking-block re-injection for multi-turn flows.
 *
 * When extended thinking is enabled and the model uses tools across multiple
 * turns, Anthropic requires the previous turn's thinking blocks (with their
 * `signature`) to be present in the next request. Vercel AI SDK v4 does NOT
 * do this automatically — we must rebuild the assistant `content` as a
 * multipart array `[{type:"thinking",thinking,signature}, {type:"text",...}]`.
 *
 * For other providers (OpenAI, Bedrock) this is a no-op: their reasoning
 * content is summary-only and not part of the conversation context.
 *
 * Inputs are persisted message rows from `getRecentMessageRows()`; output is
 * a `CoreMessage[]` ready to pass to the AI SDK. Rows for `user` and
 * `system` are returned unchanged. Assistant rows without reasoning are
 * returned as plain-text CoreMessages.
 */

import type { CoreMessage } from "ai";
import type { MessageRow } from "../conversations/store.js";
import type { ReasoningDetail } from "../conversations/schema.js";

/**
 * The Anthropic-specific multipart `content` part for a signed thinking block.
 * Vercel AI SDK v4 forwards this verbatim to the provider when the message
 * `content` is given as an array of parts.
 */
type AnthropicThinkingPart = { type: "thinking"; thinking: string; signature: string };
type AnthropicTextPart = { type: "text"; text: string };

/** Pick out signed text-type reasoning details (the only kind Anthropic accepts back).
 *  Persisted rows type `reasoning` as `unknown[]`, so each entry is narrowed
 *  against the `ReasoningDetail` shape before use. */
function pickSignedThinking(reasoning: unknown[] | null | undefined): AnthropicThinkingPart[] {
  if (!reasoning) return [];
  const out: AnthropicThinkingPart[] = [];
  for (const item of reasoning) {
    const r = item as Partial<ReasoningDetail> & { type?: unknown; signature?: unknown; text?: unknown };
    if (r.type === "text" && typeof r.text === "string" && typeof r.signature === "string" && r.signature.length > 0) {
      out.push({ type: "thinking", thinking: r.text, signature: r.signature });
    }
  }
  return out;
}

/**
 * Convert persisted message rows into `CoreMessage[]` ready for the AI gateway.
 *
 * @param rows Chronologically ordered message rows (from `getRecentMessageRows`).
 * @param provider Provider name ("anthropic" enables thinking-block re-injection).
 * @param thinking Whether the current request has `thinking: true`.
 *                 Re-injection only happens when this is true AND provider==="anthropic".
 */
export function buildMessagesWithReasoning(
  rows: MessageRow[],
  provider: string,
  thinking: boolean,
): CoreMessage[] {
  const shouldInject = provider === "anthropic" && thinking;

  return rows.map((row): CoreMessage => {
    if (row.role !== "assistant" || !shouldInject) {
      return {
        role: row.role as "user" | "assistant" | "system",
        content: row.content,
      };
    }

    const thinkingParts = pickSignedThinking(row.reasoning);
    if (thinkingParts.length === 0) {
      return { role: "assistant", content: row.content };
    }

    // Multipart content: thinking blocks first, then the assistant text.
    // Casting through `unknown` because Vercel AI SDK's CoreMessage types do
    // not formally include the Anthropic-specific `thinking` part — the SDK
    // forwards it verbatim, which is the documented integration path.
    const parts: (AnthropicThinkingPart | AnthropicTextPart)[] = [
      ...thinkingParts,
      { type: "text", text: row.content },
    ];
    return {
      role: "assistant",
      content: parts,
    } as unknown as CoreMessage;
  });
}
