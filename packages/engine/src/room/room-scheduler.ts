// SPDX-License-Identifier: AGPL-3.0-or-later

import { listEnabledRooms, type RoomConfig } from "./room.store.js";
import { countPendingByInstance, requeueEventsWithoutLiveLease, roomLeaseKey } from "../webhooks/webhook-backlog.store.js";
import { compactActivityLog } from "./activity-log.store.js";
import { executeRoomCycle } from "./room-engine.js";
import { resolveInstanceSlug } from "../instances/resolve-instance-id.js";
import { runAnalyticsCleanup } from "../analytics/cleanup.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import { resolvePlatformSettings } from "../platform/platform-settings.store.js";
import { withLease } from "../background/work-lease.js";
import { createLogger } from "../utils/create-logger.js";

const roomLog = createLogger();

const TICK_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** One lease for the whole installation: the daily housekeeping runs once, not once per replica. */
const HOUSEKEEPING_LEASE_KEY = "housekeeping:daily";

class RoomScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Rooms whose cycle runs in this process; the room's lease keeps out every other process. */
  private running = new Set<string>();
  private started = false;

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => roomLog.error("Scheduler", "tick failed", err));
    }, TICK_INTERVAL_MS);

    this.started = true;
    roomLog.info("Scheduler", `running (tick every ${TICK_INTERVAL_MS / 1000}s)`);
  }

  private async tick(): Promise<void> {
    // Events a cycle claimed and no live lease backs any more (the cycle ended without
    // completing them, or its process died) go back to pending before anything is read.
    const requeued = await requeueEventsWithoutLiveLease();
    if (requeued > 0) {
      roomLog.info("Scheduler", `requeued ${requeued} event(s) left by a cycle that no longer holds its room`);
    }

    const [rooms, pendingCounts] = await Promise.all([
      listEnabledRooms(),
      countPendingByInstance(),
    ]);
    for (const room of rooms) {
      if (this.running.has(room.instanceId)) continue;
      if ((pendingCounts.get(room.instanceId) ?? 0) === 0) continue;

      // Acquire the lock synchronously before yielding to the event loop,
      // preventing a second tick from picking up the same room while this
      // processRoom call is suspended at its first await.
      this.running.add(room.instanceId);
      this.processRoom(room).catch((err) =>
        roomLog.error("Scheduler", `error processing room ${room.instanceId}`, err),
      );
    }

    this.housekeeping(rooms).catch((err) => roomLog.error("Scheduler", "daily housekeeping failed", err));
  }

  /** Daily housekeeping: compact activity logs + purge expired analytics rows. */
  private async housekeeping(rooms: RoomConfig[]): Promise<void> {
    await withLease(HOUSEKEEPING_LEASE_KEY, { everyMs: HOUSEKEEPING_INTERVAL_MS }, async () => {
      const compactions = rooms.map((room) =>
        compactActivityLog(room.instanceId).catch((err) =>
          roomLog.error("Scheduler", `compaction error ${room.instanceId}`, err),
        ),
      );

      // Retention for every traffic-driven table: ai_logs, pipeline_traces,
      // tool_audit_logs, hook_executions, scheduled_task_runs and the COMPLETED
      // half of event_backlog. The window is the installation's own policy,
      // resolved per run — once a day, so the read costs nothing and an
      // administrator who shortens it does not wait for a restart.
      const cleanup = resolvePlatformSettings()
        .then(({ analyticsRetentionDays }) => runAnalyticsCleanup(analyticsRetentionDays))
        .then((result) => {
          roomLog.info(
            "Scheduler",
            `retention cleanup (older than ${result.cutoff.toISOString()}): ` +
              `${result.aiLogsDeleted} ai_logs, ${result.pipelineTracesDeleted} pipeline_traces, ` +
              `${result.toolAuditLogsDeleted} tool_audit_logs, ${result.hookExecutionsDeleted} hook_executions, ` +
              `${result.scheduledTaskRunsDeleted} scheduled_task_runs, ${result.eventBacklogDeleted} event_backlog`,
          );
        })
        .catch((err) => roomLog.error("Scheduler", "analytics cleanup failed", err));

      await Promise.all([...compactions, cleanup]);
    });
  }

  /**
   * Run one cycle of `room` while holding its lease, so no other process runs one at
   * the same time. Returns false when another process holds it.
   */
  private async cycle(room: RoomConfig, instanceSlug: InstanceSlug, humanMessage?: string): Promise<boolean> {
    return withLease(roomLeaseKey(room.instanceId), {}, (owner) =>
      executeRoomCycle(room, instanceSlug, owner, humanMessage),
    );
  }

  private async processRoom(room: RoomConfig): Promise<void> {
    try {
      const slug = await resolveInstanceSlug(room.instanceId);
      if (!slug) return;

      await this.cycle(room, slug);
    } finally {
      this.running.delete(room.instanceId);
    }
  }

  async triggerImmediate(room: RoomConfig, instanceSlug: InstanceSlug, humanMessage: string): Promise<void> {
    if (this.running.has(room.instanceId)) {
      roomLog.warn("Scheduler", `room for ${instanceSlug} already running, dropping human message`);
      return;
    }

    this.running.add(room.instanceId);
    try {
      if (!(await this.cycle(room, instanceSlug, humanMessage))) {
        roomLog.warn("Scheduler", `room for ${instanceSlug} is cycling in another process, dropping human message`);
      }
    } catch (err) {
      // Catch and log so the unhandled rejection cannot propagate to the webhook handler.
      // If the caller receives an error it may retry, causing double execution.
      roomLog.error("Scheduler", `triggerImmediate failed for ${instanceSlug}`, err);
    } finally {
      this.running.delete(room.instanceId);
    }
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    roomLog.info("Scheduler", "shut down");
  }

  get isRunning(): boolean {
    return this.started;
  }
}

export const roomScheduler = new RoomScheduler();
