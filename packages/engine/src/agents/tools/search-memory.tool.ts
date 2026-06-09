// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { hybridSearch } from "../../memory/index.js";
import { registerTool } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";

registerTool({
  name: "searchMemory",
  description:
    "Search long-term memory and past conversations.\n" +
    "ALWAYS use before answering questions about past facts, dates, previous discussions, memories, or recent events.\n" +
    "Do NOT use to save new information — use `saveMemory` instead.\n" +
    "Do NOT use to search documents — use `searchKnowledge` instead.\n" +
    "Returns content, type (fact/conversation), relevance score, and date for each result.\n" +
    "Caveat: uses hybrid search (semantic + keyword). More specific queries yield better results.",
  category: "memory",
  create: (ctx) => ({
    parameters: z.object({
      query: z.string().describe("What to search for in memory"),
      limit: z
        .number()
        .nullable()
        .describe("Maximum number of results (default: 10). Pass null for the default."),
    }),
    execute: async ({ query, limit }: { query: string; limit: number | null }) => {
      try {
        const results = await hybridSearch(query, ctx.instanceId, limit ?? undefined);
        ctx.audit.log({
          action: "memory.search",
          details: {
            query: auditPreview(query),
            resultCount: results.length,
          },
          success: true,
        });
        return {
          found: results.length,
          results: results.map((r) => ({
            content: r.content,
            type: r.type,
            score: r.score,
            date: r.createdAt || null,
          })),
        };
      } catch (err) {
        const message = errMsg(err);
        ctx.audit.log({
          action: "memory.search",
          details: { query: auditPreview(query) },
          success: false,
          error: message,
        });
        console.error(`searchMemory tool error: ${message}`);
        return { found: 0, results: [], error: message };
      }
    },
  }),
});