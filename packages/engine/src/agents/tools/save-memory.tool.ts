// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { embed, resolveEmbeddingContext } from "../../embeddings-gateway/index.js";
import { upsertMemory } from "../../memory/memory-store.js";
import { registerTool } from "./registry.js";
import { errMsg } from "../../utils/error.js";
import { auditPreview } from "../../audit/audit-logger.js";

registerTool({
  name: "saveMemory",
  description:
    "Save a fact to the assistant's long-term memory.\n" +
    "Use ONLY when the user explicitly asks to remember something (e.g. 'remember that...', 'save this', 'keep in mind').\n" +
    "DO NOT use to save unsolicited information — automatic memory extraction already runs in the background.\n" +
    "DO NOT use to search memories — use searchMemory.\n" +
    "Returns a save confirmation with the memory ID.\n" +
    "Caveat: similar memories (>90% similarity) are deduplicated automatically and updated rather than duplicated.",
  category: "memory",
  create: (ctx) => ({
    parameters: z.object({
      content: z.string().describe("The information to remember"),
    }),
    execute: async ({ content }: { content: string }) => {
      try {
        const embCtx = await resolveEmbeddingContext(ctx.instanceId);
        const embedding = await embed(content, embCtx);
        const result = await upsertMemory({
          instanceId: ctx.instanceId,
          content,
          category: "general",
          importance: 7,
          embedding,
          dimensions: embCtx.dimensions,
          provider: embCtx.credentials.provider,
        });
        ctx.audit.log({
          action: "memory.save",
          details: {
            contentPreview: auditPreview(content),
            category: "general",
            importance: 7,
            memoryId: result.id,
            event: result.event,
          },
          success: true,
        });
        return {
          saved: true,
          events: [{ id: result.id, event: result.event }],
        };
      } catch (err) {
        const message = errMsg(err);
        ctx.audit.log({
          action: "memory.save",
          success: false,
          error: message,
        });
        console.error(`saveMemory error: ${message}`);
        return { saved: false, error: message };
      }
    },
  }),
});