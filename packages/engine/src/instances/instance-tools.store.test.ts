// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/instances/instance-tools.store.ts
 *
 * Covers the critical reads and the "auto-recompute" mechanism:
 * - getEnabledToolNames(instanceId) returns the names from joined rows.
 * - getEnabledToolNames dedupes (Set semantics).
 * - getEnabledToolNames returns empty set when no rows exist.
 * - recomputeInstanceTools deletes-then-inserts inside a transaction (idempotent).
 * - recomputeInstanceTools is idempotent: a second call performs the same
 *   delete+insert and does NOT duplicate rows (Set-based dedup of desired set).
 * - seedInstanceTools inserts DEFAULT_TOOL_NAMES with source='manual' + onConflictDoNothing.
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
const { mockDb, mockTx } = vi.hoisted(() => {
  const mockTx = {
    delete: vi.fn(),
    insert: vi.fn(),
    // recomputeInstanceTools reads current rows inside the tx before deciding
    // delete/insert. The default returns an empty chain (no current rows);
    // individual tests can override via mockTx.select.mockReturnValueOnce(...).
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  };
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<void>) => {
      await cb(mockTx);
    }),
  };
  return { mockDb, mockTx };
});

vi.mock("../database/client.js", () => ({ db: mockDb,
  // `NO_TRANSACTION` IS `db`, named for what a call site means by passing it.
  get NO_TRANSACTION() {
    return mockDb;
  },
}));

vi.mock("./instance-tools.schema.js", () => ({
  instanceTools: {
    instanceId: "instance_id",
    toolId: "tool_id",
    source: "source",
  },
}));

vi.mock("./instance-skills.schema.js", () => ({
  instanceSkills: {
    instanceId: "instance_id",
    skillVersionId: "skill_version_id",
    enabled: "enabled",
  },
}));

vi.mock("../agents/tools/tools.schema.js", () => ({
  tools: {
    id: "id",
    name: "name",
    isGlobal: "is_global",
  },
}));

vi.mock("../skills/schema.js", () => ({
  skillVersions: {
    id: "id",
    metadata: "metadata",
  },
}));

vi.mock("./defaults.js", () => ({
  DEFAULT_TOOL_NAMES: ["createSkill", "readSkill", "spawnTask"],
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  inArray: vi.fn((...args: unknown[]) => ({ type: "inArray", args })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import {
  getEnabledToolNames,
  recomputeInstanceTools,
  seedInstanceTools,
  enableToolsByName,
} from "./instance-tools.store.js";
import { asInstanceUuid } from "./identifiers.js";
import { NO_TRANSACTION } from "../database/client.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const INSTANCE_UUID = asInstanceUuid("uuid-instance-1");

describe("instance-tools.store", () => {
  beforeEach(() => {
    // resetAllMocks clears the implementation queue (including mockReturnValueOnce
    // leftovers) — clearAllMocks only clears call history.
    mockDb.select.mockReset();
    mockDb.insert.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<void>) => {
      await cb(mockTx);
    });
    mockTx.delete.mockReset();
    mockTx.insert.mockReset();
    mockTx.select.mockReset();
    // Default: tx.select() returns an empty current-rows chain.
    mockTx.select.mockImplementation(
      () =>
        ({
          from: () => ({ where: async () => [] }),
        }) as never,
    );
  });

  // -----------------------------------------------------------------------
  // getEnabledToolNames
  // -----------------------------------------------------------------------
  describe("getEnabledToolNames", () => {
    it("returns a Set of tool names from joined rows", async () => {
      mockDb.select.mockReturnValue(
        createChainMock([
          { name: "createSkill" },
          { name: "readSkill" },
          { name: "spawnTask" },
        ]) as never,
      );

      const result = await getEnabledToolNames(INSTANCE_UUID);

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has("createSkill")).toBe(true);
      expect(result.has("readSkill")).toBe(true);
      expect(result.has("spawnTask")).toBe(true);
    });

    it("dedupes duplicate names (Set semantics)", async () => {
      mockDb.select.mockReturnValue(
        createChainMock([
          { name: "createSkill" },
          { name: "createSkill" },
          { name: "readSkill" },
        ]) as never,
      );

      const result = await getEnabledToolNames(INSTANCE_UUID);

      expect(result.size).toBe(2);
    });

    it("returns an empty Set when no rows exist", async () => {
      mockDb.select.mockReturnValue(createChainMock([]) as never);

      const result = await getEnabledToolNames(INSTANCE_UUID);

      expect(result.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // recomputeInstanceTools with precomputed global tool ids
  // -----------------------------------------------------------------------
  describe("recomputeInstanceTools with precomputed global tool ids", () => {
    /** An executor whose reads answer in the order recompute issues them. */
    function fakeExecutor(reads: unknown[][]) {
      const insertValues = vi.fn(() => Promise.resolve());
      const select = vi.fn();
      for (const rows of reads) select.mockReturnValueOnce(createChainMock(rows));
      return {
        exec: {
          select,
          insert: vi.fn(() => ({ values: insertValues })),
          delete: vi.fn(),
        },
        select,
        insertValues,
      };
    }

    it("does not read the tools table for globals when the caller supplies them", async () => {
      // Reads: enabled skills, manual rows, then the current rows of the diff.
      const { exec, select, insertValues } = fakeExecutor([[], [], []]);

      await recomputeInstanceTools(INSTANCE_UUID, exec as never, { globalToolIds: ["g1", "g2"] });

      expect(select).toHaveBeenCalledTimes(3);
      expect(insertValues).toHaveBeenCalledWith([
        { instanceId: INSTANCE_UUID, toolId: "g1", source: "global" },
        { instanceId: INSTANCE_UUID, toolId: "g2", source: "global" },
      ]);
    });

    it("reads the globals itself when none are supplied", async () => {
      // Reads: enabled skills, globals, manual rows, then the current rows of the diff.
      const { exec, select, insertValues } = fakeExecutor([[], [{ id: "g1" }], [], []]);

      await recomputeInstanceTools(INSTANCE_UUID, exec as never);

      expect(select).toHaveBeenCalledTimes(4);
      expect(insertValues).toHaveBeenCalledWith([{ instanceId: INSTANCE_UUID, toolId: "g1", source: "global" }]);
    });
  });

  // -----------------------------------------------------------------------
  // recomputeInstanceTools (idempotency and the empty set: see the integration test)
  // -----------------------------------------------------------------------
  describe("recomputeInstanceTools", () => {
    it("dedupes when a global tool also appears as a skill-required tool (global wins, no duplicate insert)", async () => {
      // Same tool id appears in skill-required AND global rows
      const enabledSkillsChain = createChainMock([
        { skillVersionId: "sv-1", metadata: { requiredTools: ["spawnTask"] } },
      ]);
      const skillToolIdsChain = createChainMock([
        { id: "tool-shared", name: "spawnTask" },
      ]);
      const globalToolRowsChain = createChainMock([{ id: "tool-shared" }]);
      const manualRowsChain = createChainMock([]);

      mockDb.select
        .mockReturnValueOnce(enabledSkillsChain as never)
        .mockReturnValueOnce(skillToolIdsChain as never)
        .mockReturnValueOnce(globalToolRowsChain as never)
        .mockReturnValueOnce(manualRowsChain as never);

      const deleteChain = createChainMock(undefined);
      const insertChain = createChainMock(undefined);
      mockTx.delete.mockReturnValue(deleteChain as never);
      mockTx.insert.mockReturnValue(insertChain as never);

      await recomputeInstanceTools(INSTANCE_UUID);

      // Only one row inserted — global wins (iterated first), skill dedup skips it
      expect(insertChain.values).toHaveBeenCalledWith([
        { instanceId: INSTANCE_UUID, toolId: "tool-shared", source: "global" },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // seedInstanceTools
  // -----------------------------------------------------------------------
  describe("enableToolsByName", () => {
    it("inserts the catalog tools as manual rows and ignores conflicts", async () => {
      mockDb.select.mockReturnValue(createChainMock([{ id: "t-search" }, { id: "t-get" }]) as never);
      const insertChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insertChain as never);

      await enableToolsByName(INSTANCE_UUID, ["searchKnowledge", "getKnowledge"], NO_TRANSACTION);

      expect(insertChain.values).toHaveBeenCalledWith([
        { instanceId: INSTANCE_UUID, toolId: "t-search", source: "manual" },
        { instanceId: INSTANCE_UUID, toolId: "t-get", source: "manual" },
      ]);
      expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    });

    it("writes nothing when none of the names is in the catalog", async () => {
      mockDb.select.mockReturnValue(createChainMock([]) as never);

      await enableToolsByName(INSTANCE_UUID, ["searchKnowledge"], NO_TRANSACTION);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("seedInstanceTools", () => {
    it("inserts DEFAULT_TOOL_NAMES with source='manual' and uses onConflictDoNothing", async () => {
      mockDb.select.mockReturnValue(
        createChainMock([
          { id: "tool-create", name: "createSkill" },
          { id: "tool-read", name: "readSkill" },
          { id: "tool-spawn", name: "spawnTask" },
        ]) as never,
      );
      const insertChain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(insertChain as never);

      await seedInstanceTools(INSTANCE_UUID, NO_TRANSACTION);

      expect(insertChain.values).toHaveBeenCalledWith([
        { instanceId: INSTANCE_UUID, toolId: "tool-create", source: "manual" },
        { instanceId: INSTANCE_UUID, toolId: "tool-read", source: "manual" },
        { instanceId: INSTANCE_UUID, toolId: "tool-spawn", source: "manual" },
      ]);
      expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    });

    it("is a no-op when no matching tool rows are found in the DB catalog", async () => {
      mockDb.select.mockReturnValue(createChainMock([]) as never);

      await seedInstanceTools(INSTANCE_UUID, NO_TRANSACTION);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Caller-transaction propagation
  //
  // `createInstanceWithDefaults` seeds inside `db.transaction`, so a write
  // issued on the module `db` takes a SECOND pooled connection, which cannot
  // see the uncommitted `instances` row held by the very transaction that
  // called it: POST /api/instances fails. These tests assert the writes land
  // on the executor they were handed.
  // -----------------------------------------------------------------------
  describe("caller-transaction propagation", () => {
    it("seedInstanceTools inserts on the caller executor, not on the module db", async () => {
      const selectChain = createChainMock([
        { id: "tool-create", name: "createSkill" },
      ]);
      const insertChain = createChainMock(undefined);
      const executor = {
        select: vi.fn(() => selectChain),
        insert: vi.fn(() => insertChain),
      };

      await seedInstanceTools(INSTANCE_UUID, executor as never);

      expect(executor.insert).toHaveBeenCalledTimes(1);
      expect(insertChain.values).toHaveBeenCalledWith([
        { instanceId: INSTANCE_UUID, toolId: "tool-create", source: "manual" },
      ]);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("recomputeInstanceTools reuses the caller executor and opens no second transaction", async () => {
      const insertChain = createChainMock(undefined);
      const executor = {
        select: vi
          .fn()
          .mockReturnValueOnce(createChainMock([])) // enabled skills
          .mockReturnValueOnce(createChainMock([{ id: "tool-global-1" }])) // globals
          .mockReturnValueOnce(createChainMock([])) // manual rows
          .mockReturnValueOnce(createChainMock([])), // current rows, inside the diff
        insert: vi.fn(() => insertChain),
        delete: vi.fn(() => createChainMock(undefined)),
      };

      await recomputeInstanceTools(INSTANCE_UUID, executor as never);

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockDb.select).not.toHaveBeenCalled();
      expect(executor.insert).toHaveBeenCalledTimes(1);
      expect(insertChain.values).toHaveBeenCalledWith([
        { instanceId: INSTANCE_UUID, toolId: "tool-global-1", source: "global" },
      ]);
    });
  });
});
