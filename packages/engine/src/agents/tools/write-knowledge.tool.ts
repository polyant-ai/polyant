// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import {
  appendAgentDocument,
  DocumentSizeExceededError,
  upsertAgentDocument,
  type AgentWriteResult,
} from "../../knowledge/store.js";
import { processDocument } from "../../knowledge/ingestion.js";
import { registerTool } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";

registerTool({
  name: "writeKnowledge",
  description:
    "Write or append content to a knowledge base document by filename.\n" +
    "Action 'write' overwrites the content (or creates the document if it does not exist).\n" +
    "Action 'append' adds new content at the end, separated by a double newline.\n" +
    "If the document does not exist, it is created with the specified `mimeType` (default: text/markdown).\n" +
    "Returns `docId` and operation confirmation.",
  category: "knowledge",
  inputExamples: [
    {
      label: "Create or overwrite a document",
      input: {
        action: "write",
        filename: "notes.md",
        content: "# Notes\n\nInitial content.",
      },
    },
    {
      label: "Append a line to an existing log",
      input: {
        action: "append",
        filename: "log.md",
        content: "2026-04-17: new event",
      },
    },
  ],
  create: (ctx) => ({
    parameters: z.object({
      action: z
        .enum(["write", "append"])
        .describe("'write' overwrites (or creates), 'append' adds at the end (or creates)"),
      filename: z
        .string()
        .min(1)
        .describe("Document filename (e.g. 'notes.md')"),
      content: z
        .string()
        .describe("Text content to write or append (UTF-8)"),
      mimeType: z
        .string()
        .nullable()
        .describe("Document MIME type, used only on creation (default: text/markdown)"),
    }),
    execute: async ({
      action,
      filename,
      content,
      mimeType,
    }: {
      action: "write" | "append";
      filename: string;
      content: string;
      mimeType?: string | null;
    }) => {
      try {
        // Append with empty payload on an existing doc is a no-op; we still try to
        // reach the store so the caller gets a consistent shape (created flag, sizeBytes).
        const effectiveMime = mimeType ?? undefined;
        let result: AgentWriteResult;
        if (action === "write") {
          result = await upsertAgentDocument({
            agentId: ctx.agentId,
            filename,
            content,
            mimeType: effectiveMime,
          });
        } else {
          result = await appendAgentDocument({
            agentId: ctx.agentId,
            filename,
            content,
            mimeType: effectiveMime,
          });
        }

        // Fire-and-forget reindex: drop old chunks, re-chunk + embed, mark "ready".
        const { docId, rawContent } = result;
        setImmediate(() => {
          processDocument(docId, ctx.agentId, rawContent).catch((err) => {
            console.error(
              `writeKnowledge reindex failed for doc ${docId}: ${errMsg(err)}`,
            );
          });
        });

        ctx.audit.log({
          action: "knowledge.write",
          details: {
            filename: auditPreview(filename),
            mode: action,
            created: result.created,
            sizeBytes: result.sizeBytes,
          },
          success: true,
        });

        return {
          ok: true,
          filename,
          docId: result.docId,
          created: result.created,
          reindexScheduled: true,
          sizeBytes: result.sizeBytes,
        };
      } catch (err) {
        const message = errMsg(err);
        const code =
          err instanceof DocumentSizeExceededError
            ? "DOCUMENT_SIZE_EXCEEDED"
            : undefined;
        ctx.audit.log({
          action: "knowledge.write",
          details: {
            filename: auditPreview(filename),
            mode: action,
            ...(code ? { code } : {}),
          },
          success: false,
          error: message,
        });
        console.error(`writeKnowledge tool error: ${message}`);
        return { ok: false, error: message, ...(code ? { code } : {}) };
      }
    },
  }),
});
