// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Markup a model sometimes leaks into its reply `content` instead of keeping it
 * in the structured `reasoning` field / tool-call slot. Three groups, each a
 * CLOSED, structural pattern that does not occur in legitimate assistant prose
 * or code — so stripping is safe and never touches real content:
 *
 *  1. CoT tags    — `<think>` / `<thinking>` / `<reasoning>` (allowlisted names,
 *                   so `Array<string>`, `x < 5`, user HTML are untouched).
 *  2. Pipe tokens — ChatML / harmony special tokens `<|im_start|>`, `<|im_end|>`,
 *                   `<|tool_call|>…`, `<|channel|>`, … (Qwen leaks these on
 *                   Bedrock). No language uses `<|…|>`, so any such token is safe
 *                   to remove; the paired `<|tool_call|>…</|tool_call|>` block is
 *                   dropped with its JSON payload.
 *  3. Harmony call — `to=functions.<name>` tool-call syntax gpt-oss leaks as
 *                   plain text (no angle brackets) on Bedrock.
 *
 * Scope stays narrow on purpose: unfilled prompt placeholders (e.g.
 * `<callbackWindow>`) are NOT removed — that is an instance prompt-authoring
 * concern. A JSON payload leaked WITHOUT a closing `<|tool_call|>` is left in
 * place (removing trailing JSON heuristically would risk real content).
 */
const REASONING_TAGS = "thinking|think|reasoning";

/** Paired block `<tag ...>…</tag>` — inner text included, non-greedy, multiline. */
const PAIRED = new RegExp(`<\\s*(${REASONING_TAGS})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, "gi");

/** Any leftover standalone opening/closing tag of the same names. */
const ORPHAN = new RegExp(`<\\s*/?\\s*(?:${REASONING_TAGS})\\b[^>]*>`, "gi");

/** Paired ChatML/harmony tool-call block — JSON payload included, non-greedy. */
const PIPE_BLOCK = /<\|tool_call\|>[\s\S]*?<\/?\|tool_call\|>/gi;

/** Any standalone ChatML/harmony special token `<|…|>` (im_start, channel, …). */
const PIPE_TOKEN = /<\|[^|>\n]{0,40}\|>/g;

/** gpt-oss/harmony tool-call syntax leaked as plain text (no angle brackets). */
const HARMONY_CALL = /\bto=functions\.[^\s<]*/gi;

/**
 * Remove chain-of-thought / channel-framing markup a model occasionally leaks
 * into its user-facing reply, before the text reaches persistence and any
 * channel. See the module doc for the three pattern groups and why each is safe.
 */
export function stripReasoningTags(text: string): string {
  // fast path: nothing tag-like or harmony-call-like to strip
  if (!text.includes("<") && !text.includes("to=functions")) return text;
  return text
    .replace(PIPE_BLOCK, "") // ChatML tool-call block + its JSON payload
    .replace(PIPE_TOKEN, "") // stray ChatML/harmony pipe tokens
    .replace(HARMONY_CALL, "") // plain-text harmony tool-call syntax
    .replace(PAIRED, "") // paired CoT blocks, inner text included
    .replace(ORPHAN, "") // stray unclosed CoT tags left behind, keep surrounding text
    .replace(/[ \t]{2,}/g, " ") // collapse the gap left where a marker sat
    .trim();
}
