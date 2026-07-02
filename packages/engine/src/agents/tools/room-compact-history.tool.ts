// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { conversationStore } from "../../conversations/index.js";
import { chat } from "../../ai-gateway/index.js";
import { resolveInstanceConfig } from "../../instances/config-resolver.js";
import { getRoomByInstanceId } from "../../room/room.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";

export default defineTool({
  name: "compact_room_history",
  description:
    "Summarize older conversation history to free up context space.\n" +
    "Use when context usage is high and you need to continue processing events without hitting limits.\n" +
    "Do NOT use at the start of a cycle — only when you notice the context is filling up.\n" +
    "Returns a compressed summary replacing older messages. Recent exchanges are preserved.\n" +
    "Caveat: keepRecent controls how many recent message pairs to preserve (default: 3). Summarization is irreversible within the current cycle.",
  category: "room",
  harness: true,
  parameters: z.object({
    keepRecent: z.number().nullable().describe("Number of recent turns to keep intact"),
  }),
  execute: async ({ keepRecent }: { keepRecent: number | null }, ctx) => {
    const recentToKeep = keepRecent ?? 10;
    const instanceId = await resolveInstanceId(ctx.instanceId);
    if (!instanceId) return { error: "Instance not found" };

    const room = await getRoomByInstanceId(instanceId);
    if (!room?.conversationId) return { error: "No room conversation to compact" };

    const allMessages = await conversationStore.getRecentMessages(room.conversationId, 100);
    if (allMessages.length <= recentToKeep) {
      return { success: true, message: "History is already small enough, no compaction needed" };
    }

    const toCompact = allMessages.slice(0, -recentToKeep);
    const compactText = toCompact
      .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
      .join("\n");

    const instanceConfig = await resolveInstanceConfig(ctx.instanceId);

    const summaryResponse = await chat(
      {
        tier: "fast",
        provider: instanceConfig.provider,
        apiKeys: instanceConfig.apiKeys,
        system: "Summarize the following conversation in 3-5 concise sentences, preserving key facts, decisions, and open items. Respond ONLY with the summary.",
        messages: [{ role: "user", content: compactText }],
      },
      { conversationId: room.conversationId, instanceId: ctx.instanceId, callType: "service" },
    );

    await conversationStore.replaceOldestMessages(
      room.conversationId,
      toCompact.length,
      summaryResponse.text.trim(),
    );

    return {
      success: true,
      compactedMessages: toCompact.length,
      keptMessages: recentToKeep,
    };
  },
});
