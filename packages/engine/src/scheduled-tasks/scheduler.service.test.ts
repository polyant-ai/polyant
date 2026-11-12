// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/scheduled-tasks/scheduler.service.ts
 *
 * Covers the lifecycle invariants of the singleton SchedulerService:
 * - start() throws when initialize() was not called.
 * - start() registers a setInterval and sets isRunning to true.
 * - shutdown() clears the interval and resets isRunning.
 * - tick() short-circuits when no due tasks.
 * - tick() respects MAX_CONCURRENT (3) — only schedules executable batch.
 * - the tick recovers runs whose lease expired, without counting a failure.
 * - the per-tick reaper fails runs past their own deadline, not past the default one.
 *
 * Uses vi.useFakeTimers() — no real setTimeout is exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockStore, mockRunLog, mockChannelManager } = vi.hoisted(() => ({
  mockStore: {
    claimDueTasks: vi.fn(),
    countDueTasks: vi.fn(),
    findExpiredRunLeases: vi.fn(),
    renewRunLease: vi.fn(),
    releaseRunLease: vi.fn(),
    markRunning: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    remove: vi.fn(),
    removeAfterRun: vi.fn(),
    update: vi.fn(),
    findStuckRunning: vi.fn(),
    countStuckRunning: vi.fn(),
    clearRunningMarker: vi.fn(),
  },
  mockRunLog: {
    createRun: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    failDanglingRuns: vi.fn(),
    findDanglingRuns: vi.fn(),
  },
  mockChannelManager: {
    sendOutbound: vi.fn(),
  },
}));

vi.mock("./store.js", () => mockStore);
vi.mock("./run-log.store.js", () => mockRunLog);
vi.mock("../channels/channel-manager.js", () => ({
  channelManager: mockChannelManager,
}));
const { mockConversationStore } = vi.hoisted(() => ({
  mockConversationStore: { ensureConversation: vi.fn(), appendMessages: vi.fn() },
}));
vi.mock("../conversations/index.js", () => ({ conversationStore: mockConversationStore }));
vi.mock("../instances/store.js", () => ({
  findInstanceBySlug: vi.fn(async () => ({ status: "active" })),
}));
vi.mock("../activity-stream/emit-helpers.js", () => ({
  resolveInstanceMeta: vi.fn(async () => undefined),
}));
vi.mock("./schedule-utils.js", () => ({
  computeNextRun: vi.fn(() => new Date()),
  computeRetryDelay: vi.fn(() => 30_000),
  MAX_CONSECUTIVE_ERRORS: 5,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { schedulerService } from "./scheduler.service.js";
import { drainBackgroundTurns } from "../channels/background-turns.js";

// The platform policies are a row; this suite has no database. The values are
// the shipped defaults, so the assertions read the same as before they moved.
vi.mock("../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: async () => ({ schedulerOrphanGraceMs: 900_000, schedulerDefaultMaxRunMs: 1_800_000 }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type MessageHandler = Parameters<typeof schedulerService.initialize>[0];

const noopHandler: MessageHandler = vi.fn(async () => ({
  text: "ok",
  toolCalls: [],
  usage: undefined,
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("SchedulerService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Suppress noisy console logs
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockStore.claimDueTasks.mockReset().mockResolvedValue([]);
    mockStore.countDueTasks.mockReset().mockResolvedValue(0);
    mockStore.findExpiredRunLeases.mockReset().mockResolvedValue([]);
    mockStore.renewRunLease.mockReset().mockResolvedValue(true);
    mockStore.releaseRunLease.mockReset().mockResolvedValue(undefined);
    mockStore.markRunning.mockReset().mockResolvedValue(new Date());
    mockStore.markCompleted.mockReset().mockResolvedValue(new Date());
    mockStore.removeAfterRun.mockReset().mockResolvedValue(true);
    mockStore.markFailed.mockReset().mockResolvedValue(true);
    mockRunLog.createRun.mockReset().mockResolvedValue("run-1");
    mockRunLog.completeRun.mockReset().mockResolvedValue(undefined);
    mockRunLog.failRun.mockReset().mockResolvedValue(undefined);
    mockRunLog.failDanglingRuns.mockReset().mockResolvedValue(0);
    mockRunLog.findDanglingRuns.mockReset().mockResolvedValue([]);
    mockStore.findStuckRunning.mockReset().mockResolvedValue([]);
    mockStore.countStuckRunning.mockReset().mockResolvedValue(0);
    mockStore.clearRunningMarker.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    // Ensure shutdown so no timer leaks between tests
    schedulerService.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // start() / shutdown() lifecycle
  // -----------------------------------------------------------------------
  describe("start / shutdown", () => {
    it("start() throws if initialize() was not called", async () => {
      // Reset internal state by accessing the singleton fresh: shutdown first
      schedulerService.shutdown();
      // Force-clear messageHandler by setting via initialize(null as any) isn't possible;
      // however on a fresh module load it's null. Since we share the singleton across tests,
      // we test the negative path by inspecting that initialize() is required for start().
      // Use the internal field reset via a fresh import would be cleaner — but the singleton
      // pattern means we just verify the documented contract here when never initialized.
      // To make this deterministic across test order, we re-set messageHandler to null via
      // a typed cast on the internal field.
      (schedulerService as unknown as { messageHandler: unknown }).messageHandler = null;

      await expect(schedulerService.start()).rejects.toThrow(
        "SchedulerService: initialize() must be called before start()",
      );
    });

    it("start() registers a setInterval and marks isRunning=true", async () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      schedulerService.initialize(noopHandler);

      await schedulerService.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      // TICK_INTERVAL_MS = 30_000
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      expect(schedulerService.isRunning).toBe(true);
    });

    it("runs nothing and rewrites no row at boot: overdue tasks wait for the tick", async () => {
      // A replica booting during a deploy must not run, or push forward, tasks another
      // replica is about to serve. The tick serves the overdue ones, oldest first.
      schedulerService.initialize(noopHandler);

      await schedulerService.start();

      expect(mockStore.claimDueTasks).not.toHaveBeenCalled();
      expect(mockStore.markRunning).not.toHaveBeenCalled();
      expect(mockStore.update).not.toHaveBeenCalled();
      expect(mockStore.clearRunningMarker).not.toHaveBeenCalled();
      expect(noopHandler).not.toHaveBeenCalled();
    });

    it("shutdown() clears the interval and sets isRunning=false", async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      schedulerService.initialize(noopHandler);
      await schedulerService.start();

      schedulerService.shutdown();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(schedulerService.isRunning).toBe(false);
    });

    it("a run in flight at shutdown is waited for by the shutdown drain, then completes", async () => {
      let finish!: () => void;
      schedulerService.initialize(() => new Promise((resolve) => {
        finish = () => resolve({ text: "done", toolCalls: [], usage: undefined } as never);
      }));
      mockStore.claimDueTasks.mockResolvedValue([{
        id: "task-live", name: "live", instanceId: "acme", schedule: { type: "cron", expression: "0 6 * * *" },
        prompt: "noop", keepHistory: false, deleteAfterRun: false, maxRetries: 3, consecutiveErrors: 0,
      }]);
      const ticking = schedulerService.tick();
      await vi.advanceTimersByTimeAsync(0);

      schedulerService.shutdown();
      let drainEnded = false;
      const drained = drainBackgroundTurns(10_000).then((outcome) => {
        drainEnded = true;
        return outcome;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(drainEnded).toBe(false);
      expect(mockStore.markCompleted).not.toHaveBeenCalled();

      finish();
      await expect(drained).resolves.toEqual({ pending: 0 });
      await ticking;
      expect(mockStore.markCompleted).toHaveBeenCalledWith("task-live", expect.any(String), expect.any(Date));
    });

    it("shutdown() when not started is a safe no-op (does not throw)", () => {
      // After the prior shutdown in afterEach, calling again should not crash
      expect(() => schedulerService.shutdown()).not.toThrow();
      expect(schedulerService.isRunning).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // tick()
  // -----------------------------------------------------------------------
  describe("tick", () => {
    it("returns immediately when there are no due tasks", async () => {
      schedulerService.initialize(noopHandler);
      mockStore.claimDueTasks.mockResolvedValue([]);

      await schedulerService.tick();

      expect(mockStore.claimDueTasks).toHaveBeenCalledTimes(1);
      expect(noopHandler).not.toHaveBeenCalled();
    });

    it("returns immediately when messageHandler is null", async () => {
      (schedulerService as unknown as { messageHandler: unknown }).messageHandler = null;

      await schedulerService.tick();

      expect(mockStore.claimDueTasks).not.toHaveBeenCalled();
    });

    it("claims at most the free slots, under a lease of the installation's orphan grace", async () => {
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(mockStore.claimDueTasks).toHaveBeenCalledWith(expect.any(Date), 3, { leaseTtlMs: 900_000, skip: [] });
    });

    it("renews the lease of a running task every quarter of its TTL, and stops and releases it when it ends", async () => {
      let finish!: () => void;
      schedulerService.initialize(() => new Promise((resolve) => {
        finish = () => resolve({ text: "", toolCalls: [], usage: undefined } as never);
      }));
      mockStore.claimDueTasks.mockResolvedValue([{
        id: "task-long", name: "long", instanceId: "acme", schedule: { type: "cron", expression: "0 6 * * *" },
        prompt: "noop", keepHistory: false, deleteAfterRun: false, maxRetries: 3, consecutiveErrors: 0,
      }]);

      const ticking = schedulerService.tick();
      await vi.advanceTimersByTimeAsync(900_000);
      expect(mockStore.renewRunLease).toHaveBeenCalledTimes(4);
      expect(mockStore.renewRunLease).toHaveBeenCalledWith("task-long", expect.any(Date), 900_000);

      expect(mockStore.releaseRunLease).not.toHaveBeenCalled();

      finish();
      await ticking;
      await vi.advanceTimersByTimeAsync(900_000);
      expect(mockStore.renewRunLease).toHaveBeenCalledTimes(4);
      // The ended run gives its lease back under the claim it renewed it with.
      const renewedClaim = mockStore.renewRunLease.mock.calls[0][1];
      expect(mockStore.releaseRunLease).toHaveBeenCalledWith("task-long", renewedClaim);
    });
  });

  // -----------------------------------------------------------------------
  // Crash-safety: runs whose lease expired
  // -----------------------------------------------------------------------
  describe("recovery of interrupted runs", () => {
    const orphan = (over: Record<string, unknown> = {}) => ({
      id: "task-orphan",
      name: "daily",
      instanceId: "acme",
      schedule: { type: "cron", expression: "0 6 * * *" },
      lastRunStatus: "running",
      updatedAt: new Date(Date.now() - 60_000),
      lastRunAt: new Date(Date.now() - 60_000),
      maxRunMs: null,
      keepHistory: false,
      deleteAfterRun: false,
      maxRetries: 3,
      consecutiveErrors: 0,
      ...over,
    });

    it("clears the running marker and closes the dangling run, before claiming work", async () => {
      // The claim skips rows marked `running`, so a recovery that ran after it would
      // leave exactly the interrupted tasks unserved for another tick.
      const calls: string[] = [];
      mockStore.findExpiredRunLeases.mockResolvedValue([orphan()]);
      mockStore.clearRunningMarker.mockImplementation(async () => {
        calls.push("clearRunningMarker");
        return ["task-orphan"];
      });
      mockRunLog.findDanglingRuns.mockResolvedValue([{ id: "run-orphan", taskId: "task-orphan" }]);
      mockStore.claimDueTasks.mockImplementation(async () => {
        calls.push("claimDueTasks");
        return [];
      });

      schedulerService.initialize(noopHandler);
      await schedulerService.tick();

      expect(calls).toEqual(["clearRunningMarker", "claimDueTasks"]);
      expect(mockRunLog.failDanglingRuns).toHaveBeenCalledWith(["run-orphan"], expect.stringContaining("interrupted"));
    });

    it("clears only the claim it read, and closes only the runs it observed before clearing", async () => {
      // Once the marker is cleared another replica may claim the task for a new run B.
      // Recovery must neither clear B's marker nor close B's run-log row, so it names
      // the claim it read and reads the dangling runs while the marker still holds.
      const task = orphan();
      const calls: string[] = [];
      mockStore.findExpiredRunLeases.mockResolvedValue([task]);
      mockRunLog.findDanglingRuns.mockImplementation(async () => {
        calls.push("findDanglingRuns");
        return [{ id: "run-a", taskId: "task-orphan" }];
      });
      mockStore.clearRunningMarker.mockImplementation(async () => {
        calls.push("clearRunningMarker");
        return ["task-orphan"];
      });
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(mockStore.clearRunningMarker).toHaveBeenCalledWith([{ id: "task-orphan", claim: task.lastRunAt }]);
      expect(calls).toEqual(["findDanglingRuns", "clearRunningMarker"]);
      expect(mockRunLog.failDanglingRuns).toHaveBeenCalledWith(["run-a"], expect.any(String));
    });

    it("does NOT count a failure for an interrupted run", async () => {
      // An interrupted run is a deploy's fault, not the task's: counting it would burn a
      // retry, push `nextRunAt` away, and after enough deploys disable the task outright.
      mockStore.findExpiredRunLeases.mockResolvedValue([orphan()]);
      mockStore.clearRunningMarker.mockResolvedValue(["task-orphan"]);

      schedulerService.initialize(noopHandler);
      await schedulerService.tick();

      expect(mockStore.markFailed).not.toHaveBeenCalled();
    });

    it("closes only rows whose running marker was actually cleared", async () => {
      mockStore.findExpiredRunLeases.mockResolvedValue([orphan()]);
      mockStore.clearRunningMarker.mockResolvedValue([]);
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(mockRunLog.failDanglingRuns).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Crash-safety: the per-tick reaper
  // -----------------------------------------------------------------------
  describe("reaper", () => {
    const runningFor = (ms: number, maxRunMs: number | null = null) => ({
      id: "task-hung",
      name: "weekly",
      instanceId: "acme",
      schedule: { type: "cron", expression: "0 8 * * 1" },
      lastRunStatus: "running",
      updatedAt: new Date(Date.now() - ms),
      lastRunAt: new Date(Date.now() - ms),
      maxRunMs,
      keepHistory: false,
      deleteAfterRun: false,
      maxRetries: 3,
      consecutiveErrors: 0,
    });

    it("fails a run past its deadline, and counts it as a failure", async () => {
      // Here the failure IS the task's own behaviour: it had its declared time and did not
      // finish, so the retry backoff is the right response.
      mockStore.findStuckRunning.mockResolvedValue([runningFor(31 * 60_000)]);
      mockRunLog.findDanglingRuns.mockResolvedValue([{ id: "run-hung", taskId: "task-hung" }]);
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(mockStore.markFailed).toHaveBeenCalledWith("task-hung", expect.stringContaining("orphaned"), expect.anything());
      expect(mockRunLog.failDanglingRuns).toHaveBeenCalledWith(["run-hung"], expect.stringContaining("orphaned"));
    });

    it("fails only the claim it read, and leaves the run log alone when the row moved on", async () => {
      // Between the read and the write the hung run may have finished and the
      // task been claimed again by another replica. The reaper must not fail
      // that newer claim, nor close its run as orphaned.
      const hung = runningFor(31 * 60_000);
      mockStore.findStuckRunning.mockResolvedValue([hung]);
      mockStore.markFailed.mockResolvedValue(false);
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(mockStore.markFailed).toHaveBeenCalledWith("task-hung", expect.any(String), hung.lastRunAt);
      expect(mockRunLog.failDanglingRuns).not.toHaveBeenCalled();
    });

    it("leaves a run alone while it is inside its deadline", async () => {
      mockStore.findStuckRunning.mockResolvedValue([runningFor(60_000)]);
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(mockStore.markFailed).not.toHaveBeenCalled();
    });

    it("honours a per-task deadline SHORTER than the default", async () => {
      // The regression this pins: bounding the scan by the default deadline would have been
      // faster and would have ignored every stricter per-task deadline until the default
      // had elapsed. So the scan reads every running row and checks each against its own.
      mockStore.findStuckRunning.mockResolvedValue([runningFor(2 * 60_000, 60_000)]);
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(mockStore.markFailed).toHaveBeenCalledWith("task-hung", expect.stringContaining("60000 ms"), expect.anything());
    });

    it("runs before the due-task claim, so a reaped row can run in the same tick", async () => {
      const calls: string[] = [];
      mockStore.findStuckRunning.mockImplementation(async () => {
        calls.push("reap");
        return [];
      });
      mockStore.claimDueTasks.mockImplementation(async () => {
        calls.push("due");
        return [];
      });
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(calls).toEqual(["reap", "due"]);
    });
  });

  // -----------------------------------------------------------------------
  // Observability: the failure here is the absence of success
  // -----------------------------------------------------------------------
  describe("outbound delivery", () => {
    const outboundTask = (channel: string, target: string) => ({
      id: "task-out",
      name: "reminder",
      instanceId: "acme",
      schedule: { type: "cron", expression: "0 9 * * *" },
      prompt: "remind",
      outboundChannel: channel,
      outboundTarget: target,
      keepHistory: true,
      deleteAfterRun: false,
      maxRetries: 3,
      consecutiveErrors: 0,
    });

    beforeEach(() => {
      mockConversationStore.ensureConversation.mockReset().mockResolvedValue({ created: true });
      mockConversationStore.appendMessages.mockReset().mockResolvedValue(undefined);
      mockChannelManager.sendOutbound.mockReset().mockResolvedValue(undefined);
    });

    it("records the delivered message in the contact's conversation, keyed as their replies are", async () => {
      // The contact's reply arrives on `+39…` and is keyed `acme:whatsapp:+39…` by the
      // inbound pipeline; the reminder it answers must be in that same conversation.
      schedulerService.initialize(noopHandler);
      await schedulerService.runNow(outboundTask("whatsapp", "whatsapp:+393331234567") as never);

      expect(mockChannelManager.sendOutbound).toHaveBeenCalledWith(
        "acme", "whatsapp", "whatsapp:+393331234567", "ok", { throwOnSuppressed: true },
      );
      expect(mockConversationStore.ensureConversation).toHaveBeenCalledWith(
        "acme:whatsapp:+393331234567",
        "acme",
        expect.objectContaining({ channel: "whatsapp", userIdentifier: "+393331234567" }),
      );
      expect(mockConversationStore.appendMessages).toHaveBeenCalledWith("acme:whatsapp:+393331234567", [
        expect.objectContaining({ role: "assistant", content: "ok" }),
      ]);
    });

    it("keys the conversation on the id the adapter reports for the delivery", async () => {
      mockChannelManager.sendOutbound.mockResolvedValue({ channelId: "D0DM42" });
      schedulerService.initialize(noopHandler);

      await schedulerService.runNow(outboundTask("slack", "U0USER1") as never);

      expect(mockConversationStore.appendMessages).toHaveBeenCalledWith("acme:slack:D0DM42", expect.any(Array));
    });

    it("records nothing when the delivery fails or is suppressed", async () => {
      mockChannelManager.sendOutbound.mockRejectedValue(new Error("Outbound suppressed by recipient opt-out"));
      schedulerService.initialize(noopHandler);

      await schedulerService.runNow(outboundTask("whatsapp", "+393331234567") as never);

      expect(mockConversationStore.appendMessages).not.toHaveBeenCalled();
    });
  });

  describe("health", () => {
    it("reports free slots and stuck rows in numbers", async () => {
      mockStore.countStuckRunning.mockResolvedValue(2);
      const h = await schedulerService.health();

      expect(h.maxConcurrent).toBe(3);
      expect(h.freeSlots).toBe(3 - h.inFlight);
      expect(h.stuckRunning).toBe(2);
      // No names of instances or tasks: the endpoint is unauthenticated.
      expect(JSON.stringify(h)).not.toContain("acme");
    });
  });
});
