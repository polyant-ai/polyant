// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";
import { findModelCapabilities } from "./model-catalog.js";
import { warnCatalogFallback } from "./config.js";

// Allowlist of vision-capable model families — the LOGGED fallback for model ids
// absent from the per-model catalog. An unlisted model has its image/file content
// parts stripped to a text note (degraded, never a provider 400). Fails safe.
// Exported so the catalog-integrity test can cross-check catalogued rows.
const VISION_CAPABLE = /gpt-4o|gpt-4\.1|gpt-5|chatgpt|claude|nova-lite|nova-pro|nova-2|vision|\bo[134]\b|-vl-|minicpm-v|cosmos3|kimi-k2\.6/i;

export function visionCapableFallback(model: string): boolean {
  return VISION_CAPABLE.test(model);
}

/**
 * Whether a model accepts image/file input. Reads the catalog `vision` field
 * (cross-provider lookup — this gate receives no provider); falls back to the
 * regex heuristic (logged) for un-catalogued ids.
 */
export function modelSupportsVision(model: string): boolean {
  const entry = findModelCapabilities(model);
  if (entry) return entry.vision;
  warnCatalogFallback("modelSupportsVision", "", model);
  return visionCapableFallback(model);
}

// Bedrock's Converse API rejects blank text content blocks (OpenAI/Anthropic tolerate
// them). Backfill marker for a message left with no content after sanitizing.
const EMPTY_PLACEHOLDER = "[attachment]";

/**
 * Sanitize the message array for the resolved model before it reaches the provider:
 *  - text-only models: replace image/file parts with a text note (the raw bytes still
 *    reach tools via ctx.attachments; the dedicated vision tool handles them);
 *  - drop blank/whitespace-only text parts (Bedrock 400s on empty text blocks — e.g. an
 *    image-only turn whose caption was "", replayed in history);
 *  - backfill a message left with empty content so no provider sees an empty turn.
 * Returns the same reference when nothing changed. Internal part typing is loose (the
 * function operates on the runtime content shape); cast back to ModelMessage at the edge.
 */
export function sanitizeMessagesForModel(messages: ModelMessage[], model: string): ModelMessage[] {
  const visionOk = modelSupportsVision(model);
  let changed = false;

  const out = messages.map((m): ModelMessage => {
    if (typeof m.content === "string") {
      if (m.content.trim() !== "") return m;
      changed = true;
      return { ...m, content: EMPTY_PLACEHOLDER } as unknown as ModelMessage;
    }
    if (!Array.isArray(m.content)) return m;

    const parts: Array<Record<string, unknown>> = [];
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (!visionOk && (part.type === "image" || part.type === "file")) {
        changed = true;
        parts.push({ type: "text", text: `[attachment: ${(part.mediaType as string) ?? "file"}]` });
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim() === "") {
        changed = true; // drop blank text block
      } else {
        parts.push(part);
      }
    }
    if (parts.length === 0) {
      changed = true;
      parts.push({ type: "text", text: EMPTY_PLACEHOLDER });
    }
    return { ...m, content: parts } as unknown as ModelMessage;
  });

  return changed ? out : messages;
}
