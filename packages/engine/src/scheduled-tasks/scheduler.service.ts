// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MessageHandler } from "../channels/types.js";
import type { ScheduleConfig, ScheduledTask, TriggerType } from "./schema.js";
import * as store from "./store.js";
import * as runLog from "./run-log.store.js";
import { computeNextRun } from "./schedule-utils.js";
import { channelManager } from "../channels/channel-manager.js";
import { scheduledTaskLog } from "./scheduled-task-logger.js";
import { emitCron } from "../activity-stream/emitters/emit-cron.js";
import { asAgentSlug } from "../instances/identifiers.js";
import { resolveInstanceMeta } from "../activity-stream/emit-helpers.js";
import { findInstanceBySlug } from "../instances/store.js";

function scheduleLabel(schedule: ScheduleConfig): string {
  switch (schedule.type) {
    case "cron":
      return schedule.expression ?? "cron";
    case "interval":
      return `every ${schedule.everyMs ?? 0} ms`;
    case "one-shot":
      return schedule.runAt ?? "one-shot";
    default:
      return "schedule";
  }
}

const TICK_INTERVAL_MS = 30_000; // Check for due tasks every 30s
const MAX_CONCURRENT = 3;

class SchedulerService {
  private messageHandler: MessageHandler | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private started = false;

  /** Wire up the message handler (call during boot) */
  initialize(messageHandler: MessageHandler): void {
    this.messageHandler = messageHandler;
  }

  /** Load tasks and start the tick loop */
  async start(): Promise<void> {
    if (!this.messageHandler) {
      throw new Error("SchedulerService: initialize() must be called before start()");
    }

    scheduledTaskLog.info("SchedulerService", "starting...");

    // Handle missed tasks on startup
    await this.handleMissedTasks();

    // Start the tick loop
    this.timer = setInterval(() => {
      this.tick().catch((err) => scheduledTaskLog.error("SchedulerService", "tick error:", err));
    }, TICK_INTERVAL_MS);

    this.started = true;
    scheduledTaskLog.info("SchedulerService", `running (tick every ${TICK_INTERVAL_MS / 1000}s)`);
  }

  /** Main loop: find and execute due tasks */
  async tick(): Promise<void> {
    if (!this.messageHandler) return;

    const now = new Date();
    const dueTasks = await store.getDueTasks(now);

    if (dueTasks.length === 0) return;

    // Limit concurrency
    const available = MAX_CONCURRENT - this.running.size;
    if (available <= 0) return;

    const batch = dueTasks.slice(0, available);

    // Execute in parallel (up to available slots)
    await Promise.allSettled(
      batch.map((task) => this.executeTask(task)),
    );
  }

  /** Execute a single scheduled task */
  private async executeTask(task: ScheduledTask, triggerType: TriggerType = "scheduled"): Promise<void> {
    // Guard: parent instance must be active. The scheduled tick already filters
    // via JOIN in `getDueTasks`, but `runNow` (manual trigger) bypasses that
    // query — and a race could let a task slip through between the tick query
    // and lock acquisition. We re-check here defensively.
    const instance = await findInstanceBySlug(asAgentSlug(task.agentId));
    if (!instance || instance.status !== "active") {
      scheduledTaskLog.info(
        "SchedulerService",
        `skipping task "${task.name}" (${task.id}): parent instance "${task.agentId}" is not active (status=${instance?.status ?? "missing"})`,
      );
      return;
    }

    // Atomic lock — prevents double execution
    const locked = await store.markRunning(task.id);
    if (!locked) return;

    this.running.add(task.id);
    const timestamp = Date.now();

    // keepHistory=true → stable conversationId (accumulates history across runs)
    // keepHistory=false → unique conversationId per execution (fresh context each time)
    const channelId = task.keepHistory
      ? `scheduled-task:${task.id}`
      : `${task.id}:${timestamp}`;
    // Must match preEnrich format: `${agentId}:${channelType}:${channelId}`
    const conversationId = `${task.agentId}:scheduled:${channelId}`;

    // Create run log entry
    let runId: string | undefined;
    try {
      runId = await runLog.createRun(task.id, asAgentSlug(task.agentId), triggerType);
    } catch (logErr) {
      scheduledTaskLog.error("SchedulerService", `failed to create run log for "${task.name}":`, logErr);
    }

    try {
      scheduledTaskLog.info("SchedulerService", `executing task "${task.name}" (${task.id})`);

      // Activity-stream emit: surface the "task is starting" signal BEFORE the
      // pipeline runs, so the panel reflects the trigger immediately rather than
      // after completion. Fire-and-forget; failures never block execution.
      resolveInstanceMeta(task.agentId)
        .then((instance) => {
          emitCron({
            taskName: task.name,
            schedule: scheduleLabel(task.schedule as ScheduleConfig),
            prompt: task.prompt,
            runId,
            triggerType,
            conversationId,
            instance,
          });
        })
        .catch(() => {
          /* resolveInstanceMeta swallows internally; guard the chain */
        });

      const result = await this.messageHandler!({
        channelType: "scheduled",
        channelId,
        agentId: asAgentSlug(task.agentId),
        userName: "scheduler",
        text: task.prompt,
        metadata: {
          scheduledTaskId: task.id,
          source: "scheduled_task",
        },
      });

      // Success
      await store.markCompleted(task.id, conversationId);
      scheduledTaskLog.info("SchedulerService", `task "${task.name}" completed`);

      // Log successful run (strip tool args to avoid persisting PII/secrets)
      if (runId) {
        const sanitizedToolCalls = result.toolCalls?.map(({ name, durationMs }) => ({ name, durationMs }));
        runLog.completeRun(runId, {
          output: result.text || undefined,
          toolCalls: sanitizedToolCalls,
          tokenUsage: result.usage,
          conversationId,
        }).catch((err) => scheduledTaskLog.error("SchedulerService", `failed to log run completion:`, err));
      }

      // Send output to configured outbound channel
      if (task.outboundChannel && task.outboundTarget && result.text) {
        try {
          await channelManager.sendOutbound(
            task.agentId,
            task.outboundChannel,
            task.outboundTarget,
            result.text,
          );
        } catch (outboundErr) {
          scheduledTaskLog.error("SchedulerService", `failed to send outbound for "${task.name}":`, outboundErr);
        }
      }

      // Handle one-shot + deleteAfterRun
      const schedule = task.schedule as ScheduleConfig;
      if (schedule.type === "one-shot" && task.deleteAfterRun) {
        await store.remove(task.id);
        scheduledTaskLog.info("SchedulerService", `one-shot task "${task.name}" deleted after run`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await store.markFailed(task.id, errorMsg);
      scheduledTaskLog.error("SchedulerService", `task "${task.name}" failed:`, errorMsg);

      // Log failed run
      if (runId) {
        runLog.failRun(runId, errorMsg).catch((logErr) =>
          scheduledTaskLog.error("SchedulerService", `failed to log run failure:`, logErr),
        );
      }
    } finally {
      this.running.delete(task.id);
    }
  }

  /** On startup, handle any tasks that were missed during downtime */
  private async handleMissedTasks(): Promise<void> {
    const now = new Date();
    const dueTasks = await store.getDueTasks(now);

    if (dueTasks.length === 0) return;

    scheduledTaskLog.info("SchedulerService", `${dueTasks.length} missed task(s) found on startup`);

    // Execute missed tasks one at a time to avoid overloading
    for (const task of dueTasks.slice(0, 5)) {
      await this.executeTask(task);
    }

    // For remaining missed tasks, just advance their nextRunAt to the future
    for (const task of dueTasks.slice(5)) {
      const schedule = task.schedule as ScheduleConfig;
      const nextRunAt = computeNextRun(schedule, now);
      if (nextRunAt) {
        await store.update(task.id, { schedule });
      }
    }
  }

  /** Execute a task immediately with "manual" trigger type (for Run Now API) */
  async runNow(task: ScheduledTask): Promise<void> {
    if (!this.messageHandler) {
      throw new Error("SchedulerService: not initialized");
    }
    await this.executeTask(task, "manual");
  }

  /** Notify the scheduler that a task was added/updated/removed (for live updates from tool/API) */
  notify(_taskId: string, _action: "added" | "updated" | "removed"): void {
    // The scheduler is DB-driven (polls every tick), so no in-memory state to update.
    // This method exists as a hook for future optimizations (e.g. re-arm timer sooner).
  }

  /** Graceful shutdown */
  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    scheduledTaskLog.info("SchedulerService", "shut down");
  }

  get isRunning(): boolean {
    return this.started;
  }
}

export const schedulerService = new SchedulerService();
