// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";

// ponytail: allowlist of vision-capable model families — an unlisted model has its
// image/file content parts stripped to a text note (degraded, never a provider 400).
// Fails safe: a new vision model not yet listed just loses inline images until added.
// Upgrade to a real per-model capability table if the catalog drifts.
const VISION_CAPABLE = /gpt-4o|gpt-4\.1|gpt-5|chatgpt|claude|nova-lite|nova-pro|nova-2|vision|\bo[134]\b/i;

export function modelSupportsVision(model: string): boolean {
  return VISION_CAPABLE.test(model);
}

/**
 * For text-only models, replace image/file content parts with a short text note so a
 * multimodal turn (e.g. a WhatsApp photo) does not 400 at the provider. The raw bytes
 * still reach tools via `ctx.attachments`; the dedicated vision tool (e.g.
 * verificaBolletta, at the vision-capable `fast` tier) handles them. Vision-capable
 * models are returned untouched (same reference).
 */
export function stripVisionForModel(messages: ModelMessage[], model: string): ModelMessage[] {
  if (modelSupportsVision(model)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const content = m.content.map((part) => {
      if (part.type === "image" || part.type === "file") {
        changed = true;
        const mediaType = (part as { mediaType?: string }).mediaType ?? "file";
        return { type: "text" as const, text: `[allegato ricevuto: ${mediaType}]` };
      }
      return part;
    });
    return { ...m, content } as ModelMessage;
  });
  return changed ? out : messages;
}
