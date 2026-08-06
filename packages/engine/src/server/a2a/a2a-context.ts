// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Message, Part } from "@a2a-js/sdk";

type TextPart = Part & { content: { $case: "text"; value: string } };

function isTextPart(part: Part): part is TextPart {
  return part.content?.$case === "text";
}

/**
 * Concatenate the text parts of an A2A Message; non-text parts (raw/url/data)
 * are ignored (MVP). The installed `@a2a-js/sdk@1.0.0` `Part` is the v1
 * protobuf shape: text content lives at `part.content.value` behind a
 * `$case: "text"` discriminant, not `part.text`.
 */
export function extractText(message: Message): string {
  return message.parts
    .filter(isTextPart)
    .map((p) => p.content.value)
    .join("");
}
