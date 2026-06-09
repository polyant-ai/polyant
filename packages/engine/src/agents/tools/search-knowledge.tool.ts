// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { searchKnowledge } from "../../knowledge/index.js";
import { registerTool } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";

registerTool({
  name: "searchKnowledge",
  description:
    "Search the assistant's document knowledge base.\n" +
    "Use to answer questions about services, procedures, costs, FAQs, and any information that may be in the documents.\n" +
    "Do NOT use to look up personal facts, past conversations, or live web information.\n" +
    "Search is semantic. Rephrase the query if initial results are not relevant.",
  category: "knowledge",
  create: (ctx) => ({
    parameters: z.object({
      query: z.string().describe("What to search for in the knowledge base"),
      limit: z
        .number()
        .nullish()
        .describe("Maximum number of results (default: 5)"),
    }),
    execute: async ({ query, limit }: { query: string; limit: number | null }) => {
      try {
        const results = await searchKnowledge(
          query,
          ctx.instanceId,
          limit ?? undefined,
        );
        ctx.audit.log({
          action: "knowledge.search",
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
            score: r.score,
            source: r.source,
            chunkIndex: r.chunkIndex,
          })),
        };
      } catch (err) {
        const message = errMsg(err);
        ctx.audit.log({
          action: "knowledge.search",
          details: { query: auditPreview(query) },
          success: false,
          error: message,
        });
        console.error(`searchKnowledge tool error: ${message}`);
        return { found: 0, results: [], error: message };
      }
    },
  }),
});
