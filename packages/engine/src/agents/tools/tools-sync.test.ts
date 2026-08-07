// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// syncToolsToDb() unit tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetToolRegistry,
  mockDbSelectWhere,
  mockDbInsertConflict,
  mockDbInsertValues,
} = vi.hoisted(() => {
  // Top-level `db.select(...)`/`db.insert(...)` — used by resolveCatalogToolIds,
  // which runs outside the boot transaction. Hoisted with the registry mock: a
  // vi.mock factory is lifted above every plain const in this file.
  const mockDbSelectWhere = vi.fn();
  const mockDbInsertConflict = vi.fn();
  return {
    mockGetToolRegistry: vi.fn(),
    mockDbSelectWhere,
    mockDbInsertConflict,
    mockDbInsertValues: vi.fn().mockReturnValue({ onConflictDoNothing: mockDbInsertConflict }),
  };
});

vi.mock("./registry.js", () => ({
  getToolRegistry: mockGetToolRegistry,
  // Pass-through implementation: input is already `string[]` in all fixtures,
  // so the keys are simply the entries themselves.
  requiredSecretKeys: (input: ReadonlyArray<string | { key: string }> | undefined) =>
    (input ?? []).map((e) => (typeof e === "string" ? e : e.key)),
}));

// Build a chainable tx mock that captures calls
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
// `tx.select({...}).from(instanceTools)` — enabled tool ids. Default: none enabled.
const mockSelectFrom = vi.fn().mockResolvedValue([]);

const mockTx = {
  insert: vi.fn().mockReturnValue({ values: mockValues }),
  delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
  select: vi.fn().mockReturnValue({ from: mockSelectFrom }),
};

vi.mock("../../database/client.js", () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
    select: vi.fn().mockReturnValue({ from: () => ({ where: mockDbSelectWhere }) }),
    insert: vi.fn().mockReturnValue({ values: mockDbInsertValues }),
  },
}));

vi.mock("./tools.schema.js", () => ({
  tools: { name: "name", id: "id" },
}));

vi.mock("../../instances/instance-tools.schema.js", () => ({
  instanceTools: { toolId: "tool_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  notInArray: vi.fn((...args: unknown[]) => ({ type: "notInArray", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  or: vi.fn((...args: unknown[]) => ({ type: "or", args })),
  not: vi.fn((...args: unknown[]) => ({ type: "not", args })),
  like: vi.fn((...args: unknown[]) => ({ type: "like", args })),
  inArray: vi.fn((...args: unknown[]) => ({ type: "inArray", args })),
}));

import { like } from "drizzle-orm";
import { syncToolsToDb, resolveCatalogToolIds } from "./tools-sync.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset chainable mocks
  mockOnConflictDoUpdate.mockResolvedValue(undefined);
  mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  mockTx.insert.mockReturnValue({ values: mockValues });
  mockDeleteWhere.mockResolvedValue(undefined);
  mockTx.delete.mockReturnValue({ where: mockDeleteWhere });
  mockSelectFrom.mockResolvedValue([]);
  mockTx.select.mockReturnValue({ from: mockSelectFrom });
  mockDbSelectWhere.mockResolvedValue([]);
  mockDbInsertConflict.mockResolvedValue(undefined);
  mockDbInsertValues.mockReturnValue({ onConflictDoNothing: mockDbInsertConflict });
});

// Helper: build a minimal ToolDefinition
function toolDef(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    description: `Description for ${name}`,
    category: overrides.category ?? "general",
    requiredSecrets: overrides.requiredSecrets ?? [],
    metaTool: overrides.metaTool ?? false,
    create: vi.fn(),
    ...overrides,
  };
}

// =========================================================================
// syncToolsToDb
// =========================================================================

describe("syncToolsToDb", () => {
  it("upserts all tools from the registry into the DB", async () => {
    const registry = new Map([
      ["toolA", toolDef("toolA")],
      ["toolB", toolDef("toolB", { category: "search" })],
    ]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    expect(mockTx.insert).toHaveBeenCalledTimes(2);
    expect(mockValues).toHaveBeenCalledTimes(2);

    // Verify first tool values
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "toolA",
        description: "Description for toolA",
        category: "general",
        requiredSecrets: [],
        isMeta: false,
        isGlobal: false,
        isHarness: false,
      }),
    );

    // Verify second tool values
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "toolB",
        category: "search",
      }),
    );
  });

  it("deletes tools from DB that are no longer in the registry", async () => {
    const registry = new Map([
      ["toolA", toolDef("toolA")],
    ]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    // Should delete tools not in ["toolA"]
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it("deletes all flat tools when registry is empty (preserving every namespaced row)", async () => {
    const registry = new Map();
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    // No inserts
    expect(mockTx.insert).not.toHaveBeenCalled();
    // Delete called once, with a where filter that excludes ALL namespaced rows.
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
  });

  it("prunes namespaced orphans but keeps flat + agent:* branches in the delete filter", async () => {
    // Namespaced plugin rows absent from the registry AND not enabled anywhere
    // are now pruned, but the delete must still (a) match flat rows via `%:%`
    // negation and (b) exclude virtual `agent:*` rows from the namespaced branch.
    const registry = new Map([["coreTool", toolDef("coreTool")]]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    const likePatterns = vi.mocked(like).mock.calls.map((c) => c[1]);
    expect(likePatterns).toContain("%:%"); // namespaced-name discriminator
    expect(likePatterns).toContain("agent:%"); // virtual agent rows excluded from the prune
  });

  it("reads enabled tool ids so referenced namespaced rows are never pruned", async () => {
    const registry = new Map([["coreTool", toolDef("coreTool")]]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    // The enabled-anywhere guard (instance_tools read) must run before the delete.
    expect(mockTx.select).toHaveBeenCalledTimes(1);
    expect(mockSelectFrom).toHaveBeenCalledTimes(1);
  });

  it("sets isGlobal=false for all tools (GLOBAL_TOOLS is now empty)", async () => {
    const globalToolNames = ["read", "readSkill", "spawnTask", "searchMemory", "saveMemory"];
    const registry = new Map(
      globalToolNames.map((name: string) => [name, toolDef(name)]),
    );
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    for (const call of mockValues.mock.calls) {
      const values = call[0] as { name: string; isGlobal: boolean };
      expect(values.isGlobal).toBe(false);
    }
  });

  it("sets isGlobal=false for non-global tools", async () => {
    const registry = new Map([
      ["customTool", toolDef("customTool")],
      ["anotherTool", toolDef("anotherTool")],
    ]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    for (const call of mockValues.mock.calls) {
      const values = call[0] as { name: string; isGlobal: boolean };
      expect(values.isGlobal).toBe(false);
    }
  });

  it("runs everything in a transaction", async () => {
    const registry = new Map([["toolA", toolDef("toolA")]]);
    mockGetToolRegistry.mockReturnValue(registry);

    const { db } = await import("../../database/client.js");

    await syncToolsToDb();

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it("correctly maps metaTool, requiredSecrets, and isHarness", async () => {
    const registry = new Map([
      ["spawnTask", toolDef("spawnTask", { metaTool: true, requiredSecrets: ["OPENAI_KEY"] })],
    ]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "spawnTask",
        isMeta: true,
        requiredSecrets: ["OPENAI_KEY"],
        isGlobal: false,
        isHarness: false,
      }),
    );
  });

  it("sets isHarness=true for harness tools", async () => {
    const registry = new Map([
      ["roomTool", toolDef("roomTool", { harness: true, category: "room" })],
    ]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "roomTool",
        isHarness: true,
      }),
    );
  });

  it("defaults category to 'general' when not provided", async () => {
    const def = toolDef("noCategory");
    delete (def as any).category;
    const registry = new Map([["noCategory", def]]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "general",
      }),
    );
  });
});

// =========================================================================
// resolveCatalogToolIds — the write path's name → id resolution
// =========================================================================

describe("resolveCatalogToolIds", () => {
  it("returns the ids already in the catalog without writing anything", async () => {
    mockGetToolRegistry.mockReturnValue(new Map([["toolA", toolDef("toolA")]]));
    mockDbSelectWhere.mockResolvedValueOnce([{ id: "id-a", name: "toolA" }]);

    const out = await resolveCatalogToolIds(["toolA"]);

    expect(out.get("toolA")).toBe("id-a");
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  // The defect this exists for: the panel offers what the REGISTRY holds, the
  // write resolves through the CATALOG. A missing mirror row used to insert
  // nothing and report success, so every tool came back disabled.
  it("materializes a catalog row the registry holds but the catalog is missing", async () => {
    mockGetToolRegistry.mockReturnValue(new Map([["toolA", toolDef("toolA")]]));
    mockDbSelectWhere
      .mockResolvedValueOnce([]) // first lookup: catalog has no row
      .mockResolvedValueOnce([{ id: "id-a", name: "toolA" }]); // after the repair

    const out = await resolveCatalogToolIds(["toolA"]);

    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ name: "toolA", description: "Description for toolA" }),
    );
    expect(out.get("toolA")).toBe("id-a");
  });

  it("leaves a name neither the catalog nor the registry holds unresolved", async () => {
    mockGetToolRegistry.mockReturnValue(new Map());
    mockDbSelectWhere.mockResolvedValueOnce([]);

    const out = await resolveCatalogToolIds(["ghost"]);

    expect(out.has("ghost")).toBe(false);
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it("does not query for an empty name list", async () => {
    const out = await resolveCatalogToolIds([]);
    expect(out.size).toBe(0);
    expect(mockDbSelectWhere).not.toHaveBeenCalled();
  });
});
