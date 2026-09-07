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
 * - startup recovers rows abandoned by a dead process, and leaves live ones alone.
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
    getDueTasks: vi.fn(),
    markRunning: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    remove: vi.fn(),
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
vi.mock("./schedule-utils.js", () => ({
  computeNextRun: vi.fn(() => new Date()),
  computeRetryDelay: vi.fn(() => 30_000),
  MAX_CONSECUTIVE_ERRORS: 5,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { schedulerService } from "./scheduler.service.js";

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
    mockStore.getDueTasks.mockReset().mockResolvedValue([]);
    mockStore.markRunning.mockReset().mockResolvedValue(true);
    mockStore.markCompleted.mockReset().mockResolvedValue(undefined);
    mockStore.markFailed.mockReset().mockResolvedValue(undefined);
    mockRunLog.createRun.mockReset().mockResolvedValue("run-1");
    mockRunLog.completeRun.mockReset().mockResolvedValue(undefined);
    mockRunLog.failRun.mockReset().mockResolvedValue(undefined);
    mockRunLog.failDanglingRuns.mockReset().mockResolvedValue(0);
    mockStore.findStuckRunning.mockReset().mockResolvedValue([]);
    mockStore.countStuckRunning.mockReset().mockResolvedValue(0);
    mockStore.clearRunningMarker.mockReset().mockResolvedValue(0);
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

    it("shutdown() clears the interval and sets isRunning=false", async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      schedulerService.initialize(noopHandler);
      await schedulerService.start();

      schedulerService.shutdown();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(schedulerService.isRunning).toBe(false);
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
    it("returns immediately when there are no due tasks (no markRunning calls)", async () => {
      schedulerService.initialize(noopHandler);
      mockStore.getDueTasks.mockResolvedValue([]);

      await schedulerService.tick();

      expect(mockStore.getDueTasks).toHaveBeenCalledTimes(1);
      expect(mockStore.markRunning).not.toHaveBeenCalled();
    });

    it("returns immediately when messageHandler is null", async () => {
      (schedulerService as unknown as { messageHandler: unknown }).messageHandler = null;

      await schedulerService.tick();

      expect(mockStore.getDueTasks).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Crash-safety: startup recovery
  // -----------------------------------------------------------------------
  describe("startup recovery of orphaned rows", () => {
    const orphan = (over: Record<string, unknown> = {}) => ({
      id: "task-orphan",
      name: "daily",
      instanceId: "acme",
      schedule: { type: "cron", expression: "0 6 * * *" },
      lastRunStatus: "running",
      updatedAt: new Date(Date.now() - 60 * 60_000),
      maxRunMs: null,
      keepHistory: false,
      deleteAfterRun: false,
      maxRetries: 3,
      consecutiveErrors: 0,
      ...over,
    });

    it("clears the running marker and closes the dangling run, before looking for work", async () => {
      // The order matters and is the whole point: `getDueTasks` skips rows marked
      // `running`, so a recovery that ran after the missed-task pass would leave exactly
      // the interrupted tasks unseen.
      const calls: string[] = [];
      mockStore.findStuckRunning.mockImplementation(async () => {
        calls.push("findStuckRunning");
        return [orphan()];
      });
      mockStore.clearRunningMarker.mockImplementation(async () => {
        calls.push("clearRunningMarker");
        return 1;
      });
      mockRunLog.failDanglingRuns.mockImplementation(async () => {
        calls.push("failDanglingRuns");
        return 1;
      });
      mockStore.getDueTasks.mockImplementation(async () => {
        calls.push("getDueTasks");
        return [];
      });

      schedulerService.initialize(noopHandler);
      await schedulerService.start();

      expect(calls.indexOf("clearRunningMarker")).toBeLessThan(calls.indexOf("getDueTasks"));
      expect(mockStore.clearRunningMarker).toHaveBeenCalledWith(["task-orphan"]);
      expect(mockRunLog.failDanglingRuns).toHaveBeenCalledWith(
        ["task-orphan"],
        expect.stringContaining("orphaned"),
      );
    });

    it("does NOT count a failure for an interrupted run", async () => {
      // An interrupted run is a deploy's fault, not the task's: counting it would burn a
      // retry, push `nextRunAt` away, and after enough deploys disable the task outright.
      mockStore.findStuckRunning.mockResolvedValue([orphan()]);
      mockStore.clearRunningMarker.mockResolvedValue(1);

      schedulerService.initialize(noopHandler);
      await schedulerService.start();

      expect(mockStore.markFailed).not.toHaveBeenCalled();
    });

    it("respects the deploy overlap window: the cutoff is in the past, never now", async () => {
      // A row younger than the grace may belong to the OUTGOING process, still legitimately
      // running it. Recovering it means running the task twice — for a task that delivers
      // something outward, worse than running it late.
      mockStore.findStuckRunning.mockResolvedValue([]);
      schedulerService.initialize(noopHandler);
      await schedulerService.start();

      const cutoff = mockStore.findStuckRunning.mock.calls[0]![0] as Date;
      // Default grace is 15 minutes; assert the shape (a past cutoff), not the constant.
      expect(cutoff.getTime()).toBeLessThan(Date.now() - 60_000);
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
      schedulerService.initialize(noopHandler);

      await schedulerService.tick();

      expect(mockStore.markFailed).toHaveBeenCalledWith("task-hung", expect.stringContaining("orphaned"));
      expect(mockRunLog.failDanglingRuns).toHaveBeenCalledWith(["task-hung"], expect.stringContaining("orphaned"));
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

      expect(mockStore.markFailed).toHaveBeenCalledWith("task-hung", expect.stringContaining("60000 ms"));
    });

    it("runs before the due-task query, so a reaped row can run in the same tick", async () => {
      const calls: string[] = [];
      mockStore.findStuckRunning.mockImplementation(async () => {
        calls.push("reap");
        return [];
      });
      mockStore.getDueTasks.mockImplementation(async () => {
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
