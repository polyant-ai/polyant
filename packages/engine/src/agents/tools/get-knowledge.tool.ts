// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { getDocumentByFilename } from "../../knowledge/store.js";
import { auditFailure } from "./shared/audit-failure.js";
import { auditPreview } from "../../audit/audit-logger.js";

/**
 * Characters one call returns (about 12k tokens). A document can be megabytes
 * of text: returned whole it would outgrow the model's context, and a replayed
 * tool result would carry it into later turns.
 */
const MAX_CONTENT_CHARS = 50_000;

export default defineTool({
  name: "getKnowledge",
  description:
    "Read the full content of a knowledge base document by filename.\n" +
    "Use when you know the exact document name and need the entire content, not just the most relevant chunks.\n" +
    "Do NOT use for semantic search or fuzzy queries — use `searchKnowledge` instead.\n" +
    "Returns the content, filename, mimeType, size, source, and timestamp.\n" +
    `A call returns at most ${MAX_CONTENT_CHARS.toLocaleString("en-US")} characters: when \`truncated\` is true, call again with \`offset\` set to \`nextOffset\` for the rest.\n` +
    "Caveat: the name must match the archived filename exactly (case-sensitive).",
  summary: {
    "en-US": "Reads a whole document from the knowledge base.",
    "it-IT": "Legge per intero un documento della base di conoscenza.",
  },
  category: "knowledge",
  inputExamples: [
    {
      label: "Load a document by name",
      input: { filename: "policy.md" },
    },
  ],
  parameters: z.object({
    filename: z
      .string()
      .min(1)
      .describe("Exact filename of the document (e.g. 'policy.md')."),
    offset: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Character position to read from: null for the start, or the `nextOffset` of the previous call."),
  }),
  execute: async ({ filename, offset }: { filename: string; offset?: number | null }, ctx) => {
      try {
        const doc = await getDocumentByFilename(ctx.instanceId, filename);
        // A switched-off document is kept for the panel and out of the agent's
        // reach: search skips it, and so does reading it by name.
        if (!doc || !doc.enabled) {
          ctx.audit.log({
            action: "knowledge.get",
            details: { filename: auditPreview(filename), found: false },
            success: true,
          });
          return { found: false };
        }

        ctx.audit.log({
          action: "knowledge.get",
          details: {
            filename: auditPreview(filename),
            found: true,
            status: doc.status,
            sizeBytes: doc.sizeBytes,
          },
          success: true,
        });

        const totalChars = doc.rawContent.length;
        const start = Math.min(offset ?? 0, totalChars);
        let end = Math.min(start + MAX_CONTENT_CHARS, totalChars);
        // Never end a page between the two halves of a surrogate pair.
        if (end < totalChars && /[\uD800-\uDBFF]/.test(doc.rawContent[end - 1])) end--;
        const truncated = end < totalChars;

        return {
          found: true,
          filename: doc.filename,
          content: doc.rawContent.slice(start, end),
          truncated,
          ...(truncated ? { nextOffset: end } : {}),
          totalChars,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes,
          source: doc.source,
          status: doc.status,
          updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
        };
      } catch (err) {
        const message = auditFailure(ctx, "knowledge.get", { filename: auditPreview(filename) }, err, "getKnowledge");
        return { found: false, error: message };
      }
  },
});
