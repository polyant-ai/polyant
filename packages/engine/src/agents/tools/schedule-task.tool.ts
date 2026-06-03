// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { registerTool } from "./registry.js";
import { auditPreview } from "../../audit/audit-logger.js";
import * as scheduledTaskStore from "../../scheduled-tasks/store.js";
import { parseRelativeDuration, formatScheduleHuman } from "../../scheduled-tasks/schedule-utils.js";
import { schedulerService } from "../../scheduled-tasks/scheduler.service.js";
import type { ScheduleConfig } from "../../scheduled-tasks/schema.js";

/** Build a ScheduleConfig from tool params, returning either the config or an error string. */
function buildScheduleConfig(params: {
  scheduleType: "cron" | "interval" | "one-shot";
  cronExpression?: string | null;
  timezone?: string | null;
  everyMs?: number | null;
  runAt?: string | null;
}): ScheduleConfig | { error: string } {
  switch (params.scheduleType) {
    case "cron": {
      if (!params.cronExpression) return { error: "Field 'cronExpression' is required for type cron." };
      return {
        type: "cron",
        expression: params.cronExpression,
        timezone: params.timezone ?? undefined,
      };
    }
    case "interval": {
      if (!params.everyMs) return { error: "Field 'everyMs' is required for type interval." };
      return { type: "interval", everyMs: params.everyMs };
    }
    case "one-shot": {
      if (!params.runAt) return { error: "Field 'runAt' is required for type one-shot." };
      const runAt = params.runAt.startsWith("+")
        ? parseRelativeDuration(params.runAt).toISOString()
        : params.runAt;
      return { type: "one-shot", runAt };
    }
  }
}

registerTool({
  name: "scheduleTask",
  description:
    "Manage scheduled tasks: create, list, update, delete, or run a task immediately.\n" +
    "Use for recurring automations, reminders, and scheduled jobs. Tasks run as new conversations.\n" +
    "Supports cron (e.g. '0 9 * * 1-5'), interval (e.g. every 2h), and one-shot (e.g. '+20m').\n" +
    "Do NOT use for immediate actions — execute them directly with other tools.\n" +
    "Returns task ID, human-readable schedule, and next scheduled run.\n" +
    "Caveat: action 'run' requires `taskId`. Required fields depend on the action (`create` requires name+prompt+scheduleType; `update`/`delete`/`run` require `taskId`).",
  category: "agent",
  inputExamples: [
    {
      label: "Create a recurring cron task Mon–Fri at 9am",
      input: { action: "create", name: "Daily standup", prompt: "Check status of open tasks", scheduleType: "cron", cronExpression: "0 9 * * 1-5" },
    },
    {
      label: "Create a one-shot reminder in 20 minutes",
      input: { action: "create", name: "Follow-up call", prompt: "Remind to call back", scheduleType: "one-shot", runAt: "+20m", deleteAfterRun: true },
    },
    {
      label: "List active tasks",
      input: { action: "list" },
    },
  ],
  create: (ctx) => ({
    parameters: z.object({
      action: z
        .enum(["create", "list", "update", "delete", "run"])
        .describe("Action to perform"),

      // --- create fields ---
      name: z.string().nullable().describe("Task name"),
      prompt: z
        .string()
        .nullable()
        .describe("Message/prompt to execute when the task fires"),
      scheduleType: z
        .enum(["cron", "interval", "one-shot"])
        .nullable()
        .describe("Schedule type"),
      cronExpression: z
        .string()
        .nullable()
        .describe("Cron expression (e.g. '0 9 * * 1-5' = Mon–Fri at 9am)"),
      timezone: z
        .string()
        .nullable()
        .describe("IANA timezone (e.g. 'Europe/London', 'America/New_York'). Default: UTC"),
      everyMs: z
        .number()
        .nullable()
        .describe("Interval in milliseconds (for type 'interval')"),
      runAt: z
        .string()
        .nullable()
        .describe("ISO timestamp or relative duration '+20m', '+1h', '+2d' (for type 'one-shot')"),
      description: z.string().nullable().describe("Task description"),
      deleteAfterRun: z
        .boolean()
        .nullable()
        .describe("If true, delete the task after its first execution (useful for one-shot)"),

      // --- outbound notification ---
      outboundChannel: z
        .enum(["telegram", "slack", "whatsapp"])
        .nullable()
        .describe("Channel to send the task output to (telegram, slack, whatsapp). Null means no notification."),
      outboundTarget: z
        .string()
        .nullable()
        .describe("Recipient ID on the channel (e.g. Telegram chat ID, Slack channel ID). Required when `outboundChannel` is set."),
      keepHistory: z
        .boolean()
        .nullable()
        .describe("If true, preserve conversation history across runs and allow continuing the conversation from the channel. Default: false (each run starts fresh)."),

      // --- update/delete/run fields ---
      taskId: z
        .string()
        .nullable()
        .describe("Task ID (required for update, delete, run)"),
      enabled: z
        .boolean()
        .nullable()
        .describe("Enable or disable the task (for update)"),
    }),
    execute: async (params: {
      action: "create" | "list" | "update" | "delete" | "run";
      name: string | null;
      prompt: string | null;
      scheduleType: "cron" | "interval" | "one-shot" | null;
      cronExpression: string | null;
      timezone: string | null;
      everyMs: number | null;
      runAt: string | null;
      description: string | null;
      deleteAfterRun: boolean | null;
      outboundChannel: "telegram" | "slack" | "whatsapp" | null;
      outboundTarget: string | null;
      keepHistory: boolean | null;
      taskId: string | null;
      enabled: boolean | null;
    }) => {
      try {
        switch (params.action) {
          case "create": {
            if (!params.name) return { error: "Field 'name' is required." };
            if (!params.prompt) return { error: "Field 'prompt' is required." };
            if (!params.scheduleType) return { error: "Field 'scheduleType' is required." };

            const scheduleOrError = buildScheduleConfig(params as Parameters<typeof buildScheduleConfig>[0]);
            if ("error" in scheduleOrError) return scheduleOrError;
            const schedule = scheduleOrError;

            const task = await scheduledTaskStore.create({
              instanceId: ctx.instanceId,
              name: params.name,
              prompt: params.prompt,
              schedule,
              description: params.description ?? undefined,
              deleteAfterRun: params.deleteAfterRun ?? false,
              createdBy: "agent",
              outboundChannel: params.outboundChannel ?? null,
              outboundTarget: params.outboundTarget ?? null,
              keepHistory: params.keepHistory ?? false,
            });

            schedulerService.notify(task.id, "added");

            ctx.audit.log({
              action: "task.schedule",
              details: { subAction: "create", taskId: task.id, label: auditPreview(task.name) },
              success: true,
            });

            return {
              success: true,
              task: {
                id: task.id,
                name: task.name,
                schedule: formatScheduleHuman(schedule),
                nextRunAt: task.nextRunAt?.toISOString() ?? null,
                enabled: task.enabled,
              },
            };
          }

          case "list": {
            // Cap the LLM-facing list at 50 to keep tool-result tokens bounded.
            // Instances with more than 50 active tasks are exceptional; if the
            // model needs to inspect more, it must paginate via a future
            // `offset` argument. The admin API exposes the full list via
            // explicit pagination.
            const tasks = await scheduledTaskStore.listByInstance(ctx.instanceId, { limit: 50 });
            ctx.audit.log({
              action: "task.schedule",
              details: { subAction: "list", resultCount: tasks.length },
              success: true,
            });
            return {
              tasks: tasks.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
                schedule: formatScheduleHuman(t.schedule as ScheduleConfig),
                enabled: t.enabled,
                nextRunAt: t.nextRunAt?.toISOString() ?? null,
                lastRunAt: t.lastRunAt?.toISOString() ?? null,
                lastRunStatus: t.lastRunStatus,
                consecutiveErrors: t.consecutiveErrors,
                totalRuns: t.totalRuns,
              })),
            };
          }

          case "update": {
            if (!params.taskId) return { error: "Field 'taskId' is required for action 'update'." };

            const updateData: scheduledTaskStore.UpdateTaskInput = {};
            if (params.name) updateData.name = params.name;
            if (params.prompt) updateData.prompt = params.prompt;
            if (params.description != null) updateData.description = params.description;
            if (params.enabled != null) updateData.enabled = params.enabled;
            if (params.deleteAfterRun != null) {
              updateData.deleteAfterRun = params.deleteAfterRun;
            }
            if (params.outboundChannel != null) updateData.outboundChannel = params.outboundChannel;
            if (params.outboundTarget != null) updateData.outboundTarget = params.outboundTarget;
            if (params.keepHistory != null) updateData.keepHistory = params.keepHistory;

            // Rebuild schedule if any schedule field is provided
            if (params.scheduleType) {
              const scheduleOrError = buildScheduleConfig(params as Parameters<typeof buildScheduleConfig>[0]);
              if ("error" in scheduleOrError) return scheduleOrError;
              updateData.schedule = scheduleOrError;
            }

            const updated = await scheduledTaskStore.update(params.taskId, updateData);
            if (!updated) return { error: `Task with ID '${params.taskId}' not found.` };

            schedulerService.notify(params.taskId, "updated");

            ctx.audit.log({
              action: "task.schedule",
              details: { subAction: "update", taskId: params.taskId, label: auditPreview(updated.name) },
              success: true,
            });

            return {
              success: true,
              task: {
                id: updated.id,
                name: updated.name,
                enabled: updated.enabled,
                nextRunAt: updated.nextRunAt?.toISOString() ?? null,
              },
            };
          }

          case "delete": {
            if (!params.taskId) return { error: "Field 'taskId' is required for action 'delete'." };

            const existing = await scheduledTaskStore.getById(params.taskId);
            if (!existing) return { error: `Task with ID '${params.taskId}' not found.` };

            await scheduledTaskStore.remove(params.taskId);
            schedulerService.notify(params.taskId, "removed");

            ctx.audit.log({
              action: "task.schedule",
              details: { subAction: "delete", taskId: params.taskId },
              success: true,
            });

            return { success: true, deleted: params.taskId };
          }

          case "run": {
            if (!params.taskId) return { error: "Field 'taskId' is required for action 'run'." };

            const task = await scheduledTaskStore.getById(params.taskId);
            if (!task) return { error: `Task with ID '${params.taskId}' not found.` };

            // Trigger immediate execution by setting nextRunAt to now
            await scheduledTaskStore.update(params.taskId, {
              enabled: true,
              schedule: task.schedule as ScheduleConfig,
            });

            ctx.audit.log({
              action: "task.schedule",
              details: { subAction: "run", taskId: params.taskId, label: auditPreview(task.name) },
              success: true,
            });

            return {
              success: true,
              message: `Task '${task.name}' will run on the next scheduler cycle (within 30 seconds).`,
            };
          }
        }
      } catch (err) {
        ctx.audit.log({
          action: "task.schedule",
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return { error: `Error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  }),
});
