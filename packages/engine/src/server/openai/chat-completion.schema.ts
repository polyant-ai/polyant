// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

// Restrict model to the instance-slug shape — same pattern as instances.controller.ts.
// This is the only user-controlled value that we echo back into the SSE stream
// (role chunk, finish chunk, every text/think chunk) so it MUST be a safe identifier
// to neutralise reflected-XSS taint.
const MODEL_SLUG_RE = /^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$/;

/**
 * A chat request body. `content` is text only: the history reaches the model as
 * the caller sent it, and a file or image part carrying a URL would make the
 * engine download that URL on the caller's behalf.
 */
export const chatCompletionSchema = z.object({
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(MODEL_SLUG_RE, "model must be a lowercase slug (a-z, 0-9, _, ., -)"),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })).min(1).max(100),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  chat_id: z.string().max(128).optional(),
}).passthrough();

/**
 * The native stream routes take the same body; their URL names the agent, so a
 * `model` field is ignored rather than required.
 */
export const chatStreamSchema = chatCompletionSchema.extend({
  model: z.string().max(128).optional(),
});
