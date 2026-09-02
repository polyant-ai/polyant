// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MessageHandler } from "../channels/types.js";
import type { ScheduleConfig, ScheduledTask, TriggerType } from "./schema.js";
import * as store from "./store.js";
import * as runLog from "./run-log.store.js";
import { computeNextRun } from "./schedule-utils.js";
import { channelManager } from "../channels/channel-manager.js";
import { scheduledTaskLog } from "./scheduled-task-logger.js";
import { emitCron } from "../activity-stream/emitters/emit-cron.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { resolveInstanceMeta } from "../activity-stream/emit-helpers.js";
import { findInstanceBySlug } from "../instances/store.js";
import { config } from "../config.js";

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

/**
 * Runs executed in parallel per tick, and — since the counter is a field of this
 * singleton — across the whole process, every instance included.
 *
 * Sizing, for the record: with N instances each holding a daily and a weekly task on
 * hash-offset crons, the arrival rate is what matters, not N. Two tasks that fire in the
 * same 30s tick queue behind each other, so 3 covers a fleet whose crons are spread over
 * a window of hours — 30 instances over a 3-hour window average one arrival per 6 minutes,
 * twelve ticks apart. What breaks the reasoning is not fleet growth, it is DURATION: three
 * runs that never finish hold all three slots and every other instance stops. That is why
 * the reaper below exists, and why the free-slot count is reported rather than inferred.
 *
 * Revisit when either holds: crons cluster into the same tick (a fleet-wide fixed time
 * instead of hash offsets), or a normal run's p95 approaches a tick.
 */
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

    // Recover rows abandoned by a process that is gone. MUST run before
    // handleMissedTasks: `getDueTasks` skips rows marked `running`, so without this the
    // missed-task pass would not see exactly the tasks that were interrupted.
    await this.recoverOrphanedRuns();

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

    // Free rows whose run overran its deadline before looking for work: a reaped row can
    // become due again in this very tick, and the free-slot metric must reflect reality.
    await this.reapOverrunningRuns();

    const now = new Date();
    const dueTasks = await store.getDueTasks(now);

    if (dueTasks.length === 0) return;

    // Limit concurrency
    const available = MAX_CONCURRENT - this.running.size;
    if (available <= 0) {
      // Not an error, and that is the problem: no exception is thrown while every slot is
      // held, so the only signal that the loop has stopped is this line and the free-slot
      // count on /health/scheduler. Failure here is the ABSENCE of success.
      scheduledTaskLog.warn(
        "SchedulerService",
        `all ${MAX_CONCURRENT} concurrency slots busy, ${dueTasks.length} task(s) waiting — ` +
          "no task will run this tick",
      );
      return;
    }

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
    const instance = await findInstanceBySlug(asInstanceSlug(task.instanceId));
    if (!instance || instance.status !== "active") {
      scheduledTaskLog.info(
        "SchedulerService",
        `skipping task "${task.name}" (${task.id}): parent instance "${task.instanceId}" is not active (status=${instance?.status ?? "missing"})`,
      );
      return;
    }

    // In-process guard, on top of the DB lock below. The reaper can free a row whose
    // execution is still alive in THIS process (a hung HTTP call, say): without this
    // check the freed row would be picked up again and the same task would run twice
    // concurrently — one of the two deliveries being a duplicate.
    if (this.running.has(task.id)) {
      scheduledTaskLog.warn(
        "SchedulerService",
        `task "${task.name}" (${task.id}) is still executing in this process — skipping`,
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
    // Must match preEnrich format: `${instanceId}:${channelType}:${channelId}`
    const conversationId = `${task.instanceId}:scheduled:${channelId}`;

    // Create run log entry
    let runId: string | undefined;
    try {
      runId = await runLog.createRun(task.id, asInstanceSlug(task.instanceId), triggerType);
    } catch (logErr) {
      scheduledTaskLog.error("SchedulerService", `failed to create run log for "${task.name}":`, logErr);
    }

    try {
      scheduledTaskLog.info("SchedulerService", `executing task "${task.name}" (${task.id})`);

      // Activity-stream emit: surface the "task is starting" signal BEFORE the
      // pipeline runs, so the panel reflects the trigger immediately rather than
      // after completion. Fire-and-forget; failures never block execution.
      resolveInstanceMeta(task.instanceId)
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
        instanceId: asInstanceSlug(task.instanceId),
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
            task.instanceId,
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

  /**
   * Startup recovery: rows left `running` by a process that is gone.
   *
   * `markRunning` marks a row `running` and, before this, nothing ever cleared it —
   * `getDueTasks` excludes those rows, so a task interrupted by a deploy, an OOM kill or
   * a crash went silent permanently, with no error emitted anywhere. It is a generic bug,
   * not one specific to any product: every deployment that restarts the engine while a
   * task runs has been hitting it.
   *
   * Only rows older than `orphanGraceMs` are touched. During a rolling deploy the previous
   * process may still be legitimately running its task; recovering it would run it twice,
   * which for a task that delivers something outward is worse than running it late.
   *
   * The marker is cleared WITHOUT counting a failure: an interrupted run is not the task's
   * fault, so it consumes no retry and does not push `nextRunAt` away. The run itself is
   * closed as an error in the run log, so the audit still says what happened.
   */
  private async recoverOrphanedRuns(): Promise<void> {
    const cutoff = new Date(Date.now() - config.scheduler.orphanGraceMs);
    const stuck = await store.findStuckRunning(cutoff);
    if (stuck.length === 0) return;

    const ids = stuck.map((t) => t.id);
    const cleared = await store.clearRunningMarker(ids);
    const closed = await runLog.failDanglingRuns(
      ids,
      "orphaned: the process running this task did not survive to report an outcome",
    );

    scheduledTaskLog.warn(
      "SchedulerService",
      `recovered ${cleared} orphaned task row(s) and closed ${closed} dangling run(s): ` +
        stuck.map((t) => `"${t.name}" (${t.instanceId})`).join(", "),
    );
  }

  /**
   * Per-tick reaper: runs that are still `running` past their deadline.
   *
   * The startup recovery only helps when the process restarts. A run that hangs in a live
   * process — an HTTP call with no timeout is the usual cause — holds its row forever and
   * one of the three concurrency slots with it. Past `max_run_ms` (per task, falling back
   * to `config.scheduler.defaultMaxRunMs`) the row is marked failed so the task is not
   * silenced beyond the deadline it declared.
   *
   * Unlike the startup path this DOES count as a failure: the run had its declared time
   * and did not finish, which is the task's own behaviour, and the retry backoff plus
   * `MAX_CONSECUTIVE_ERRORS` are the right response to a task that hangs every time.
   *
   * What this cannot do is cancel the hung execution: the slot stays held until the
   * process ends, which is precisely why the free-slot count is reported.
   */
  private async reapOverrunningRuns(): Promise<void> {
    // EVERY running row is read, then checked against ITS OWN deadline. Bounding the scan
    // by the default deadline would have been faster and wrong: a task declaring a shorter
    // `max_run_ms` than the default would not appear in the scan until the default had
    // elapsed, so its own deadline would be silently ignored. There are only ever a
    // handful of running rows, and the partial index covers them.
    const now = Date.now();
    const running = await store.findStuckRunning(new Date(now));
    if (running.length === 0) return;

    for (const task of running) {
      const deadline = task.maxRunMs ?? config.scheduler.defaultMaxRunMs;
      const runningForMs = now - (task.updatedAt?.getTime() ?? now);
      if (runningForMs < deadline) continue;

      await store.markFailed(
        task.id,
        `orphaned: run exceeded its deadline of ${deadline} ms (running for ${runningForMs} ms)`,
      );
      await runLog.failDanglingRuns([task.id], `orphaned: run exceeded ${deadline} ms`);
      scheduledTaskLog.warn(
        "SchedulerService",
        `reaped task "${task.name}" (${task.instanceId}): running for ${runningForMs} ms, ` +
          `deadline ${deadline} ms`,
      );
    }
  }

  /**
   * What the scheduler can say about itself, for `/health/scheduler`.
   *
   * Both numbers exist because the failure mode here is silence: a stalled loop emits no
   * error, and `enabled` stays true on every task while nothing runs. `freeSlots` at zero
   * over consecutive scrapes, or a non-zero `stuckRunning`, are the only observable
   * symptoms.
   */
  async health(): Promise<{
    running: boolean;
    maxConcurrent: number;
    inFlight: number;
    freeSlots: number;
    stuckRunning: number;
    orphanGraceMs: number;
  }> {
    const cutoff = new Date(Date.now() - config.scheduler.defaultMaxRunMs);
    return {
      running: this.started,
      maxConcurrent: MAX_CONCURRENT,
      inFlight: this.running.size,
      freeSlots: MAX_CONCURRENT - this.running.size,
      stuckRunning: await store.countStuckRunning(cutoff),
      orphanGraceMs: config.scheduler.orphanGraceMs,
    };
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
