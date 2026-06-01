// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/scheduled-tasks/store.ts
 *
 * Covers the critical mutation invariants:
 * - markRunning(id) is an atomic guard: returns true when the row was not
 *   already "running", false on race (no rows updated).
 * - markFailed increments consecutiveErrors and writes the error message.
 * - markFailed disables the task (enabled = false, nextRunAt = null) when
 *   consecutiveErrors reaches MAX_CONSECUTIVE_ERRORS.
 * - markFailed uses computeRetryDelay backoff for retries within maxRetries.
 *
 * These invariants protect the scheduler from double execution and runaway
 * failing tasks — both hard to debug in production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Chain mock helper
// ---------------------------------------------------------------------------
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) {
        chain[prop] = vi.fn(() => self);
      }
      return chain[prop];
    },
  });
  return self;
}

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockDb, mockComputeNextRun, mockComputeRetryDelay } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
  mockComputeNextRun: vi.fn(() => new Date("2026-06-01T00:00:00Z")),
  mockComputeRetryDelay: vi.fn((n: number) => (n + 1) * 30_000),
}));

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("./schema.js", () => ({
  scheduledTasks: {
    id: "id",
    instanceId: "instance_id",
    name: "name",
    enabled: "enabled",
    nextRunAt: "next_run_at",
    lastRunAt: "last_run_at",
    lastRunStatus: "last_run_status",
    lastError: "last_error",
    lastConversationId: "last_conversation_id",
    consecutiveErrors: "consecutive_errors",
    totalRuns: "total_runs",
    schedule: "schedule",
    maxRetries: "max_retries",
    outboundChannel: "outbound_channel",
    outboundTarget: "outbound_target",
    keepHistory: "keep_history",
    updatedAt: "updated_at",
  },
}));

vi.mock("./schedule-utils.js", () => ({
  computeNextRun: mockComputeNextRun,
  computeRetryDelay: mockComputeRetryDelay,
  MAX_CONSECUTIVE_ERRORS: 5,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  lte: vi.fn((...args: unknown[]) => ({ type: "lte", args })),
  or: vi.fn((...args: unknown[]) => ({ type: "or", args })),
  isNull: vi.fn((...args: unknown[]) => ({ type: "isNull", args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      type: "sql",
      strings,
      values,
    }),
    {
      raw: (s: string) => ({ type: "sql.raw", s }),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { markRunning, markFailed } from "./store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TASK_ID = "task-uuid-1";

interface TaskRow {
  id: string;
  consecutiveErrors: number;
  maxRetries: number;
  schedule: { type: "interval"; everyMs: number };
}

const BASE_TASK: TaskRow = {
  id: TASK_ID,
  consecutiveErrors: 0,
  maxRetries: 3,
  schedule: { type: "interval", everyMs: 60_000 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("scheduled-tasks/store", () => {
  beforeEach(() => {
    mockDb.select.mockReset();
    mockDb.update.mockReset();
    mockComputeNextRun.mockReset().mockReturnValue(new Date("2026-06-01T00:00:00Z"));
    mockComputeRetryDelay.mockReset().mockImplementation((n: number) => (n + 1) * 30_000);
  });

  // -----------------------------------------------------------------------
  // markRunning — atomic guard
  // -----------------------------------------------------------------------
  describe("markRunning", () => {
    it("returns true when the row was successfully marked running (not previously running)", async () => {
      // returning() resolves to [{ id }] when one row was updated
      mockDb.update.mockReturnValue(createChainMock([{ id: TASK_ID }]) as never);

      const result = await markRunning(TASK_ID);

      expect(result).toBe(true);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
    });

    it("returns false when the row was already 'running' (race lost, zero rows updated)", async () => {
      // returning() resolves to [] when WHERE clause filtered out the row
      mockDb.update.mockReturnValue(createChainMock([]) as never);

      const result = await markRunning(TASK_ID);

      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // markFailed
  // -----------------------------------------------------------------------
  describe("markFailed", () => {
    function wireGetById(task: TaskRow | undefined): void {
      const rows = task ? [task] : [];
      mockDb.select.mockReturnValue(createChainMock(rows) as never);
    }

    it("increments consecutiveErrors and stores the error message", async () => {
      wireGetById({ ...BASE_TASK, consecutiveErrors: 0 });
      const updateChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updateChain as never);

      await markFailed(TASK_ID, "boom");

      const setArgs = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArgs.consecutiveErrors).toBe(1);
      expect(setArgs.lastError).toBe("boom");
      expect(setArgs.lastRunStatus).toBe("error");
      expect(setArgs.enabled).toBeUndefined(); // not yet at limit
    });

    it("uses computeRetryDelay backoff when within maxRetries", async () => {
      wireGetById({ ...BASE_TASK, consecutiveErrors: 0, maxRetries: 3 });
      const updateChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updateChain as never);

      const beforeMs = Date.now();
      await markFailed(TASK_ID, "transient");
      const afterMs = Date.now();

      // consecutive becomes 1 → computeRetryDelay called with (1 - 1) = 0
      expect(mockComputeRetryDelay).toHaveBeenCalledWith(0);
      const setArgs = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      const nextRunAt = setArgs.nextRunAt as Date;
      expect(nextRunAt).toBeInstanceOf(Date);
      // Should be approximately now + 30s (the mock returns 30_000 for index 0)
      expect(nextRunAt.getTime()).toBeGreaterThanOrEqual(beforeMs + 30_000);
      expect(nextRunAt.getTime()).toBeLessThanOrEqual(afterMs + 30_000 + 1000);
    });

    it("advances to the normal next schedule when consecutive exceeds maxRetries (but under MAX_CONSECUTIVE_ERRORS)", async () => {
      // maxRetries=2, currently at 3 → next consecutive=4 (>2, <5)
      wireGetById({ ...BASE_TASK, consecutiveErrors: 3, maxRetries: 2 });
      const updateChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updateChain as never);

      await markFailed(TASK_ID, "still failing");

      expect(mockComputeRetryDelay).not.toHaveBeenCalled();
      expect(mockComputeNextRun).toHaveBeenCalled();
      const setArgs = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArgs.consecutiveErrors).toBe(4);
      expect(setArgs.enabled).toBeUndefined();
    });

    it("disables the task (enabled=false, nextRunAt=null) when consecutiveErrors reaches MAX_CONSECUTIVE_ERRORS", async () => {
      // 4 → next will be 5 = MAX_CONSECUTIVE_ERRORS
      wireGetById({ ...BASE_TASK, consecutiveErrors: 4 });
      const updateChain = createChainMock(undefined);
      mockDb.update.mockReturnValue(updateChain as never);

      await markFailed(TASK_ID, "give up");

      const setArgs = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArgs.consecutiveErrors).toBe(5);
      expect(setArgs.enabled).toBe(false);
      expect(setArgs.nextRunAt).toBeNull();
      expect(setArgs.lastError).toBe("give up");
    });

    it("is a no-op (no update) when the task does not exist", async () => {
      wireGetById(undefined);

      await markFailed(TASK_ID, "ghost");

      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });
});
