// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Filter out empty / malformed events emitted by the upstream activity bus.
 *
 * The backend bus may emit "text" events with no body (assistant messages
 * that ended without a final reply, or serialised empty arrays). These are
 * pure noise on the panel — we drop them at the SSE entry point instead of
 * polluting the feed.
 *
 * Pure function: trivially testable, no side effects.
 */

import type { FeedEvent } from "@/lib/activity-stream/types";

/** Strings that signal a vacuous body (assistant produced nothing meaningful). */
const EMPTY_BODY_PATTERNS = new Set([
  "",
  "«»",
  "«[]»",
  "«{}»",
  "[]",
  "{}",
]);

export function isNoiseEvent(evt: FeedEvent): boolean {
  // Tool events are always meaningful — they record an action, even when the
  // result is empty. Keep them.
  if (evt.tool) return false;

  // Reasoning events are kept if they have any text or responsePreview.
  if (evt.persona === "thinking") {
    return !hasMeaningfulText(evt.text) && !hasMeaningfulText(evt.responsePreview);
  }

  // Plain assistant text events with no body are noise.
  if (!hasMeaningfulText(evt.text) && !hasMeaningfulText(evt.responsePreview)) {
    return true;
  }

  // Reply events whose body is purely structured JSON (memory extraction
  // payloads, summarisation outputs, internal task results) are not
  // user-facing replies — they pollute the live feed without informing the
  // audience. Drop them.
  const body = evt.responsePreview ?? evt.text;
  if (looksLikePureJson(body)) return true;

  return false;
}

/**
 * True when the string is entirely a JSON value (object or array). Whitespace
 * around the value is tolerated. Used to filter out structured assistant
 * outputs that aren't human-readable replies.
 */
function looksLikePureJson(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const wraps =
    (first === "[" && last === "]") || (first === "{" && last === "}");
  if (!wraps) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function hasMeaningfulText(s: string | undefined | null): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  if (EMPTY_BODY_PATTERNS.has(trimmed)) return false;
  return true;
}
