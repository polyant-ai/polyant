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
  mockQueueHumanMessage,
  mockAppendDailyLog,
} = vi.hoisted(() => ({
  mockListEnabledRooms: vi.fn(),
  mockCountPendingEvents: vi.fn(),
  mockCompactActivityLog: vi.fn(),
  mockExecuteRoomCycle: vi.fn(),
  mockResolveInstanceSlug: vi.fn(),
  mockRoomLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockWithLease: vi.fn(),
  mockRequeue: vi.fn(),
  mockQueueHumanMessage: vi.fn(),
  mockAppendDailyLog: vi.fn(),
}));

vi.mock("./room.store.js", () => ({ listEnabledRooms: mockListEnabledRooms }));
vi.mock("../webhooks/webhook-backlog.store.js", () => ({
  countPendingByInstance: mockCountPendingEvents,
  requeueEventsWithoutLiveLease: mockRequeue,
  queueHumanMessage: mockQueueHumanMessage,
  roomLeaseKey: (instanceId: string) => `room:${instanceId}`,
  MAX_ROOM_EVENT_ATTEMPTS: 3,
}));
// The lease itself is covered against a real database in room-lease.integration.test.ts.
vi.mock("../background/work-lease.js", () => ({ withLease: mockWithLease }));
vi.mock("../analytics/cleanup.js", () => ({ runAnalyticsCleanup: vi.fn() }));
vi.mock("../platform/platform-settings.store.js", () => ({ resolvePlatformSettings: vi.fn(() => new Promise(() => {})) }));
vi.mock("./activity-log.store.js", () => ({ compactActivityLog: mockCompactActivityLog, appendDailyLog: mockAppendDailyLog }));
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
import { drainBackgroundTurns, pendingBackgroundTurns } from "../channels/background-turns.js";
import { asInstanceUuid } from "../instances/identifiers.js";

/* ── helpers ────────────────────────────────────────────────────── */

/** The scheduler's private tick and in-process set, as the tests below drive them. */
const internals = roomScheduler as unknown as { tick(): Promise<void>; running: Set<string> };

const ROOM_A = {
  id: "room-a",
  instanceId: asInstanceUuid("inst-a"),
  enabled: true,
  prompt: "Agent A",
  outboundChannel: "slack" as const,
  outboundTarget: "#a",
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
  mockRequeue.mockResolvedValue({ requeued: 0, exhausted: [] });
  mockAppendDailyLog.mockResolvedValue(undefined);
  mockQueueHumanMessage.mockResolvedValue("msg-1");
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

  describe("shutdown", () => {
    it("a cycle in flight at shutdown is counted by the shutdown drain until it ends", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map([["inst-a", 1]]));
      let finish!: () => void;
      mockExecuteRoomCycle.mockImplementation(() => new Promise<void>((r) => { finish = r; }));

      await internals.tick();
      await vi.waitFor(() => expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(1));
      roomScheduler.shutdown();
      expect(pendingBackgroundTurns()).toBeGreaterThan(0);

      const drained = drainBackgroundTurns(10_000);
      finish();
      await expect(drained).resolves.toEqual({ pending: 0 });
    });
  });

  describe("triggerImmediate", () => {
    it("queues the human message and runs a cycle for it", async () => {
      await roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "Help me please");

      expect(mockQueueHumanMessage).toHaveBeenCalledWith("inst-a", "Help me please");
      expect(mockExecuteRoomCycle).toHaveBeenCalledWith(ROOM_A, "inst-a-slug", "owner-1");
    });

    it("queues a message that arrives during a cycle for the next one instead of dropping it", async () => {
      let resolveFirst!: () => void;
      mockExecuteRoomCycle.mockImplementationOnce(
        () => new Promise<void>((r) => { resolveFirst = r; }),
      );

      const firstCycle = roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "First message");
      await vi.waitFor(() => expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(1));
      await roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "Second message");

      expect(mockQueueHumanMessage.mock.calls.map((c) => c[1])).toEqual(["First message", "Second message"]);
      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(1);

      resolveFirst();
      await firstCycle;
    });

    it("queues nothing and starts no cycle when the channel has already cancelled the run", async () => {
      await roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "a", () => false);

      expect(mockQueueHumanMessage).not.toHaveBeenCalled();
      expect(mockExecuteRoomCycle).not.toHaveBeenCalled();
    });

    it("asks the channel's gate before queuing, so the run is no longer cancelled once it has", async () => {
      const order: string[] = [];
      mockQueueHumanMessage.mockImplementation(async () => { order.push("queue"); return "msg-1"; });

      await roomScheduler.triggerImmediate(ROOM_A, asInstanceSlug("inst-a-slug"), "a", () => {
        order.push("gate");
        return true;
      });

      expect(order).toEqual(["gate", "queue"]);
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
      await internals.tick();

      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(1);
    });

    it("should skip rooms with no pending events", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map());

      await internals.tick();

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
      await internals.tick();

      // Only 1 call: the second tick skipped room A
      expect(mockExecuteRoomCycle).toHaveBeenCalledTimes(1);

      // Cleanup
      resolveProcess();
    });

    it("skips a room whose lease another process holds", async () => {
      mockListEnabledRooms.mockResolvedValue([ROOM_A]);
      mockCountPendingEvents.mockResolvedValue(new Map([["inst-a", 2]]));
      mockWithLease.mockImplementation(async (key: string) => !key.startsWith("room:"));

      await internals.tick();
      await vi.waitFor(() => expect(internals.running.has("inst-a")).toBe(false));

      expect(mockExecuteRoomCycle).not.toHaveBeenCalled();
    });

    it("requeues events without a live lease on every tick, before reading the rooms", async () => {
      const order: string[] = [];
      mockRequeue.mockImplementation(async () => { order.push("requeue"); return { requeued: 2, exhausted: [] }; });
      mockListEnabledRooms.mockImplementation(async () => { order.push("rooms"); return []; });

      await (roomScheduler as any).tick();
      await (roomScheduler as any).tick();

      expect(order).toEqual(["requeue", "rooms", "requeue", "rooms"]);
    });

    it("reports the events the requeue gave up on in the engine log and in each Room's activity log", async () => {
      mockRequeue.mockResolvedValue({
        requeued: 0,
        exhausted: [
          { id: "evt-1", instanceId: "inst-a" },
          { id: "evt-2", instanceId: "inst-a" },
          { id: "evt-3", instanceId: "inst-b" },
        ],
      });

      await internals.tick();

      expect(mockAppendDailyLog).toHaveBeenCalledTimes(2);
      expect(mockAppendDailyLog).toHaveBeenCalledWith("inst-a", expect.stringContaining("evt-1, evt-2"), 2);
      expect(mockAppendDailyLog).toHaveBeenCalledWith("inst-b", expect.stringContaining("evt-3"), 1);
      const errors = mockRoomLog.error.mock.calls.map((c) => String(c[1]));
      expect(errors.filter((m) => m.includes("gave up"))).toHaveLength(2);
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
