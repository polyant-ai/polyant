// SPDX-License-Identifier: AGPL-3.0-or-later

import { scheduledTasks } from "../scheduled-tasks/schema.js";
import { computeNextRun } from "../scheduled-tasks/schedule-utils.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { TxClient } from "./import.types.js";

export async function importScheduledTasks(
  tx: TxClient,
  instanceId: string,
  tasks: NonNullable<ExportInstanceData["scheduledTasks"]>,
): Promise<void> {
  for (const task of tasks) {
    const schedule = task.schedule as import("../scheduled-tasks/schema.js").ScheduleConfig;
    const nextRunAt = task.enabled ? computeNextRun(schedule) : null;

    await tx.insert(scheduledTasks).values({
      instanceId,
      name: task.name,
      description: task.description,
      enabled: task.enabled,
      schedule,
      prompt: task.prompt,
      outboundChannel: task.outboundChannel,
      outboundTarget: task.outboundTarget,
      keepHistory: task.keepHistory,
      deleteAfterRun: task.deleteAfterRun,
      maxRetries: task.maxRetries,
      createdBy: task.createdBy,
      nextRunAt,
    });
  }
}
