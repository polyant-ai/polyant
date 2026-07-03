// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { getDocumentByFilename } from "../../knowledge/store.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";

export default defineTool({
  name: "getKnowledge",
  description:
    "Read the full content of a knowledge base document by filename.\n" +
    "Use when you know the exact document name and need the entire content, not just the most relevant chunks.\n" +
    "Do NOT use for semantic search or fuzzy queries — use `searchKnowledge` instead.\n" +
    "Returns the full content, filename, mimeType, size, source, and timestamp.\n" +
    "Caveat: the name must match the archived filename exactly (case-sensitive).",
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
  }),
  execute: async ({ filename }: { filename: string }, ctx) => {
      try {
        const doc = await getDocumentByFilename(ctx.instanceId, filename);
        if (!doc) {
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

        return {
          found: true,
          filename: doc.filename,
          content: doc.rawContent,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes,
          source: doc.source,
          status: doc.status,
          updatedAt: doc.updatedAt ? doc.updatedAt.toISOString() : null,
        };
      } catch (err) {
        const message = errMsg(err);
        ctx.audit.log({
          action: "knowledge.get",
          details: { filename: auditPreview(filename) },
          success: false,
          error: message,
        });
        console.error(`getKnowledge tool error: ${message}`);
        return { found: false, error: message };
      }
  },
});
