// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Message, Part } from "@a2a-js/sdk";

type TextPart = Part & { content: { $case: "text"; value: string } };

/**
 * Bounds on untrusted A2A input before it becomes the LLM turn. `@a2a-js/sdk`'s
 * JSON-RPC body is limited only by the global Express body limit, so one
 * accepted request could otherwise carry a multi-megabyte prompt.
 * 64KB mirrors the existing webhook payload cap.
 */
export const MAX_TEXT_PARTS = 64;
export const MAX_TEXT_CHARS = 64 * 1024;

function isTextPart(part: Part): part is TextPart {
  return part.content?.$case === "text";
}

/**
 * Concatenate the text parts of an A2A Message; non-text parts (raw/url/data)
 * are ignored (MVP). The installed `@a2a-js/sdk@1.0.0` `Part` is the v1
 * protobuf shape: text content lives at `part.content.value` behind a
 * `$case: "text"` discriminant, not `part.text`.
 *
 * At most {@link MAX_TEXT_PARTS} text parts are read and the result is
 * truncated to {@link MAX_TEXT_CHARS}; the excess is dropped silently (the
 * request is still served — a hard rejection would surface as an opaque
 * JSON-RPC error to a client that cannot see our limit).
 */
export function extractText(message: Message): string {
  const parts = message.parts.filter(isTextPart).slice(0, MAX_TEXT_PARTS);
  let out = "";
  for (const part of parts) {
    out += part.content.value;
    if (out.length >= MAX_TEXT_CHARS) return out.slice(0, MAX_TEXT_CHARS);
  }
  return out;
}
