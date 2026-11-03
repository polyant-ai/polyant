// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

/* ── hoisted mocks ─────────────────────────────────────────────── */

const {
  mockListEnabledRooms,
  mockCountPendingEvents,
  mockCompactActivityLog,
  mockExecuteRoomCycle,
  mockResolveInstanceSlug,
  mockRoomLog,
  mockWithLease,
  mockRequeue,
} = vi.hoisted(() => ({
  mockListEnabledRooms: vi.fn(),
  mockCountPendingEvents: vi.fn(),
  mockCompactActivityLog: vi.fn(),
  mockExecuteRoomCycle: vi.fn(),
  mockResolveInstanceSlug: vi.fn(),
  mockRoomLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockWithLease: vi.fn(),
  mockRequeue: vi.fn(),
}));

vi.mock("./room.store.js", () => ({ listEnabledRooms: mockListEnabledRooms }));
vi.mock("../webhooks/webhook-backlog.store.js", () => ({
  countPendingByInstance: mockCountPendingEvents,
  requeueEventsWithoutLiveLease: mockRequeue,
  roomLeaseKey: (instanceId: string) => `room:${instanceId}`,
}));
// The lease itself is covered against a real database in room-lease.integration.test.ts.
vi.mock("../background/work-lease.js", () => ({ withLease: mockWithLease }));
vi.mock("../analytics/cleanup.js", () => ({ runAnalyticsCleanup: vi.fn() }));
vi.mock("../platform/platform-settings.store.js", () => ({ resolvePlatformSettings: vi.fn(() => new Promise(() => {})) }));
vi.mock("./activity-log.store.js", () => ({ compactActivityLog: mockCompactActivityLog }));
vi.mock("./room-engine.js", () => ({ executeRoomCycle: mockExecuteRoomCycle }));
vi.mock("../instances/resolve-instance-id.js", () => ({
  resolveInstanceSlug: mockResolveInstanceSlug,
}));
vi.mock("../utils/create-logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/create-logger.js")>()),
  createLogger: () => mockRoomLog,
}));

/* ── import under test ─────────────────────────────────────────── */

import { roomScheduler } from "./room-scheduler.js";
import { asInstanceUuid } from "../instances/identifiers.js";

/* ── helpers ────────────────────────────────────────────────────── */

const ROOM_A = {
  id: "room-a",
  instanceId: asInstanceUuid("inst-a"),
  enabled: true,
  prompt: "Agent A",
  outboundChannel: "slack" as const,
  outboundTarget: "#a",
  evalIntervalMinutes: 5,
  conversationId: "room:inst-a",
};

/* ── setup ──────────────────────────────────────────────────────── */

beforeEach(() => {
  vi.clearAllMocks();
  mockListEnabledRooms.mockResolvedValue([]);
  mockCountPendingEvents.mockResolvedValue(0);
  mockCompactActivityLog.mockResolvedValue(undefined);
  mockExecuteRoomCycle.mockResolvedValue(undefined);
  mockResolveInstanceSlug.mockResolvedValue("inst-a-slug");
  mockRequeue.mockResolvedValue(0);
  // No other process holds the lease: the body runs under a fixed owner.
  mockWithLease.mockImplementation(async (_key: string, _opts: unknown, body: (owner: string) => Promise<void>) => {
    await body("owner-1");
    return true;
  });
});

afterEach(() => {
  roomScheduler.shutdown();
});

/* ── tests ──────────────────────────────────────────────────────── */

describe("RoomScheduler", () => {
  describe("lifecycle", () => {
    it("should report isRunning correctly", () => {
      expect(roomScheduler.isRunning).toBe(false);
      roomScheduler.start();
      expect(roomScheduler.isRunning).toBe(true);
      roomScheduler.shutdown();
      expect(roomScheduler.isRunning).toBe(false);
    });

    it("should log startup and shutdown messages", () => {
      roomScheduler.start();
      expect(mockRoomLog.info).toHaveBeenCalledWith("Scheduler", expect.stringContaining("running"));

      roomScheduler.shutdown();
      expect(mockRoomLog.info).toHaveBeenCalledWith("Scheduler", "shut down");
    });
  });

  describe("triggerImmediate", () => {
    it("should execute room cycle with human message", async () => {
      await roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "Help me please");

      expect(mockExecuteRoomCycle).toHaveBeenCalledWith(ROOM_A, "inst-a-slug", "owner-1", "Help me please");
    });

    it("should drop human message if room is already running", async () => {
      // Simulate a long-running cycle that never resolves
      let resolveFirst!: () => void;
      mockExecuteRoomCycle.mockImplementationOnce(
        () => new Promise<void>((r) => { resolveFirst = r; }),
      );

      // Start first cycle (will hang)
      const firstCycle = roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "First message");

      // Try to trigger again while first is still running — should be dropped
      await roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "Second message");

      expect(mockRoomLog.warn).toHaveBeenCalledWith("Scheduler", expect.stringContaining("already running"));
      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(1);

      // Cleanup: resolve the hanging promise
      resolveFirst();
      await firstCycle;
    });

    it("should swallow errors, log them, and release room lock (#94)", async () => {
      const failure = new Error("LLM timeout");
      mockExecuteRoomCycle
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(undefined);

      // First call MUST NOT reject — the webhook handler must not retry on exception.
      await expect(
        roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "Will fail"),
      ).resolves.toBeUndefined();

      expect(mockRoomLog.error).toHaveBeenCalledWith(
        "Scheduler",
        expect.stringContaining("triggerImmediate failed"),
        failure,
      );

      // Second call should proceed (lock released in finally)
      await roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "Should work");

      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(2);
    });
  });

  describe("error resilience", () => {
    it("should not crash if triggerImmediate is called concurrently for different rooms", async () => {
      const ROOM_B = { ...ROOM_A, id: "room-b", instanceId: asInstanceUuid("inst-b"), conversationId: "room:inst-b" };

      await Promise.all([
        roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "Message A"),
        roomScheduler.triggerImmediate(ROOM_B, asInstanceSlug("inst-b-slug"), "Message B"),
      ]);

      // Both should have been processed (different instanceIds)
      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(2);
    });
  });

  describe("tick() mutex — race condition protection (#41)", () => {
    it("should process a room with pending events", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map([["inst-a", 3]]));
      mockExecuteRoomCycle.mockResolvedValue(undefined);

      // Access private tick() method
      await (roomScheduler as any).tick();

      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(1);
    });

    it("should skip rooms with no pending events", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map());

      await (roomScheduler as any).tick();

      expect(mockExecuteRoomCycle).not.toHaveBeenCalled();
    });

    it("should not process the same room twice on concurrent ticks", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map([["inst-a", 5]]));

      // First tick: processRoom will hang (never resolves during test)
      let resolveProcess!: () => void;
      mockExecuteRoomCycle.mockImplementation(
        () => new Promise<void>((r) => { resolveProcess = r; }),
      );

      // First tick — starts processing room A
      const tick1 = (roomScheduler as any).tick();
      await tick1;

      // Second tick — room A still running, should be skipped
      await (roomScheduler as any).tick();

      // Only 1 call: the second tick skipped room A
      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(1);

      // Cleanup
      resolveProcess();
    });

    it("skips a room whose lease another process holds", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map([["inst-a", 2]]));
      mockWithLease.mockImplementation(async (key: string) => !key.startsWith("room:"));

      await (roomScheduler as any).tick();
      await vi.waitFor(() => expect((roomScheduler as any).running.has("inst-a")).toBe(false));

      expect(mockExecuteRoomCycle).not.toHaveBeenCalled();
    });

    it("requeues events without a live lease on every tick, before reading the rooms", async () => {
      const order: string[] = [];
      mockRequeue.mockImplementation(async () => { order.push("requeue"); return 2; });
      mockListEnabledRooms.mockImplementation(async () => { order.push("rooms"); return []; });

      await (roomScheduler as any).tick();
      await (roomScheduler as any).tick();

      expect(order).toEqual(["requeue", "rooms", "requeue", "rooms"]);
    });

    it("runs the daily housekeeping only under its once-a-day lease", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map());
      mockWithLease.mockImplementation(async () => false);

      await (roomScheduler as any).tick();

      expect(mockWithLease).toHaveBeenCalledWith("housekeeping:daily", { everyMs: 86_400_000 }, expect.any(Function));
      expect(mockCompactActivityLog).not.toHaveBeenCalled();
    });

    it("should process different rooms in parallel", async () => {
      const ROOM_B = { ...ROOM_A, id: "room-b", instanceId: asInstanceUuid("inst-b"), conversationId: "room:inst-b" };
      mockListEnabledRooms.mockResolvedValue([ROOM_A, ROOM_B]);
      mockCountPendingEvents.mockResolvedValue(
        new Map([["inst-a", 2], ["inst-b", 1]]),
      );
      mockResolveInstanceSlug
        .mockResolvedValueOnce("inst-a-slug")
        .mockResolvedValueOnce("inst-b-slug");
      mockExecuteRoomCycle.mockResolvedValue(undefined);

      await (roomScheduler as any).tick();

      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(2);
    });

    it("should release lock when processRoom throws", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map([["inst-a", 1]]));

      // First tick: processRoom fails
      mockExecuteRoomCycle.mockRejectedValueOnce(new Error("LLM crash"));

      await (roomScheduler as any).tick();

      // processRoom is fire-and-forget inside tick(): wait deterministically for
      // its finally block to release the per-room lock before the second tick.
      // Polling `running.has(...)` avoids depending on a fixed setTimeout delay.
      await vi.waitFor(() => {
        expect((roomScheduler as any).running.has("inst-a")).toBe(false);
      });

      // Second tick: room should be available again (lock released in finally)
      mockExecuteRoomCycle.mockResolvedValueOnce(undefined);
      await (roomScheduler as any).tick();

      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(2);
    });

    it("should acquire lock synchronously before processRoom's first await", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map([["inst-a", 1]]));

      // Track the exact moment the lock is acquired vs. executeRoomCycle is called
      const order: string[] = [];

      // Override running.has to track when it's checked on the second tick
      const originalHas = (roomScheduler as any).running.has.bind((roomScheduler as any).running);
      vi.spyOn((roomScheduler as any).running, "has").mockImplementation(((key: string) => {
        const result = originalHas(key);
        if (key === "inst-a") order.push(result ? "has:true" : "has:false");
        return result;
      }) as any);

      mockExecuteRoomCycle.mockImplementation(async () => {
        order.push("executeRoomCycle:start");
      });

      await (roomScheduler as any).tick();

      // Fire-and-forget processRoom: wait deterministically until the mocked
      // executeRoomCycle has actually been invoked (its push to `order` is the
      // signal that processRoom progressed past the first await).
      await vi.waitFor(() => {
        expect(order).toContain("executeRoomCycle:start");
      });

      // The lock was acquired (has returned false, then add() was called)
      // before executeRoomCycle started
      expect(order[0]).toBe("has:false");
      expect(order).toContain("executeRoomCycle:start");
    });
  });
});
