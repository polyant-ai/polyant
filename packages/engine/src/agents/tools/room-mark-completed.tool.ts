// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { markEventsCompleted } from "../../webhooks/webhook-backlog.store.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";

export default defineTool({
  name: "mark_events_completed",
  description:
    "Mark one or more backlog events as completed.\n" +
    "Use after you have finished processing events and they no longer require action.\n" +
    "Do NOT use for events that still need follow-up — leave them in the backlog.\n" +
    "Returns confirmation with the number of events marked as completed.\n" +
    "Caveat: requires event IDs from the backlog. Optional notes field for resolution details. Events are scoped to the current instance.",
  category: "room",
  harness: true,
  parameters: z.object({
    eventIds: z.array(z.string()).describe("IDs of backlog events to mark as completed"),
    notes: z.string().nullable().describe("Optional notes about how the events were resolved"),
  }),
  execute: async ({ eventIds, notes }: { eventIds: string[]; notes: string | null }, ctx) => {
    const instanceId = await resolveInstanceId(ctx.instanceId);
    if (!instanceId) return { error: "Instance not found" };
    await markEventsCompleted(eventIds, notes ?? undefined, instanceId);
    return { success: true, completedCount: eventIds.length };
  },
});
