// SPDX-License-Identifier: AGPL-3.0-or-later

import { listEnabledRooms, type RoomConfig } from "./room.store.js";
import { countPendingByInstance } from "../webhooks/webhook-backlog.store.js";
import { compactActivityLog } from "./activity-log.store.js";
import { executeRoomCycle } from "./room-engine.js";
import { resolveInstanceSlug } from "../instances/resolve-instance-id.js";
import { roomLog } from "./room-logger.js";
import { runAnalyticsCleanup } from "../analytics/cleanup.js";
import { config } from "../config.js";
import { type InstanceSlug } from "../instances/identifiers.js";

const TICK_INTERVAL_MS = 30_000;
const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;

class RoomScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private lastHousekeeping: Date = new Date(0);
  private started = false;

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => roomLog.error("Scheduler", "tick failed", err));
    }, TICK_INTERVAL_MS);

    this.started = true;
    roomLog.info("Scheduler", `running (tick every ${TICK_INTERVAL_MS / 1000}s)`);
  }

  private async tick(): Promise<void> {
    const now = new Date();
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

    // Daily housekeeping: compact activity logs + purge expired analytics rows.
    if (now.getTime() - this.lastHousekeeping.getTime() > HOUSEKEEPING_INTERVAL_MS) {
      this.lastHousekeeping = now;
      for (const room of rooms) {
        compactActivityLog(room.instanceId).catch((err) =>
          roomLog.error("Scheduler", `compaction error ${room.instanceId}`, err),
        );
      }

      // Analytics retention: delete `ai_logs` + `pipeline_traces` older than
      // ANALYTICS_RETENTION_DAYS. Fire-and-forget; failures are logged.
      runAnalyticsCleanup(config.analytics.retentionDays)
        .then((result) => {
          roomLog.info(
            "Scheduler",
            `analytics cleanup: deleted ${result.aiLogsDeleted} ai_logs + ${result.pipelineTracesDeleted} pipeline_traces older than ${result.cutoff.toISOString()}`,
          );
        })
        .catch((err) => roomLog.error("Scheduler", "analytics cleanup failed", err));
    }
  }

  private async processRoom(room: RoomConfig): Promise<void> {
    try {
      const slug = await resolveInstanceSlug(room.instanceId);
      if (!slug) return;

      await executeRoomCycle(room, slug);
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
      await executeRoomCycle(room, instanceSlug, humanMessage);
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
