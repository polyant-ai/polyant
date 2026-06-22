// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { registerTool } from "./registry.js";
import { markEventsCompleted } from "../../webhooks/webhook-backlog.store.js";
import { resolveAgentId } from "../../instances/resolve-agent-id.js";

registerTool({
  name: "mark_events_completed",
  description:
    "Mark one or more backlog events as completed.\n" +
    "Use after you have finished processing events and they no longer require action.\n" +
    "Do NOT use for events that still need follow-up — leave them in the backlog.\n" +
    "Returns confirmation with the number of events marked as completed.\n" +
    "Caveat: requires event IDs from the backlog. Optional notes field for resolution details. Events are scoped to the current agent.",
  category: "room",
  harness: true,
  create: (ctx) => ({
    parameters: z.object({
      eventIds: z.array(z.string()).describe("IDs of backlog events to mark as completed"),
      notes: z.string().nullable().describe("Optional notes about how the events were resolved"),
    }),
    execute: async ({ eventIds, notes }: { eventIds: string[]; notes: string | null }) => {
      const agentId = await resolveAgentId(ctx.agentId);
      if (!agentId) return { error: "Agent not found" };
      await markEventsCompleted(eventIds, notes ?? undefined, agentId);
      return { success: true, completedCount: eventIds.length };
    },
  }),
});
