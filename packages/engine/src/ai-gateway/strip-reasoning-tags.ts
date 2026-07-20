// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tag names the model sometimes leaks as inline chain-of-thought into its reply
 * text. A CLOSED allowlist — we never strip arbitrary `<...>` tokens, so
 * legitimate content (code like `Array<string>`, comparisons like `x < 5`,
 * user-requested HTML) is never touched. These three names do not occur as
 * literal tags in normal assistant prose. Longer names first so the alternation
 * prefers `thinking` over `think`.
 */
const REASONING_TAGS = "thinking|think|reasoning";

/** Paired block `<tag ...>…</tag>` — inner text included, non-greedy, multiline. */
const PAIRED = new RegExp(`<\\s*(${REASONING_TAGS})\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, "gi");

/** Any leftover standalone opening/closing tag of the same names. */
const ORPHAN = new RegExp(`<\\s*/?\\s*(?:${REASONING_TAGS})\\b[^>]*>`, "gi");

/**
 * Remove chain-of-thought markup the model occasionally leaks into its reply
 * `content`. Reasoning is meant to travel in the structured `reasoning` field,
 * never inside user-facing text; when a model emits it inline as `<think>` /
 * `<thinking>` / `<reasoning>` tags this strips it before the text reaches
 * persistence and any channel.
 *
 * Scope is deliberately narrow (three known tag names). Unfilled prompt
 * placeholders (e.g. `<callbackWindow>`) are NOT removed — those are an instance
 * prompt-authoring concern, not a framework one.
 */
export function stripReasoningTags(text: string): string {
  if (!text.includes("<")) return text; // fast path: nothing tag-like to strip
  return text
    .replace(PAIRED, "") // paired blocks, inner CoT text included
    .replace(ORPHAN, "") // stray unclosed tags left behind, keep surrounding text
    .replace(/[ \t]{2,}/g, " ") // collapse the gap left where a tag sat
    .trim();
}
