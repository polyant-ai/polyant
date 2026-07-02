// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// syncToolsToDb() unit tests
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetToolRegistry,
} = vi.hoisted(() => ({
  mockGetToolRegistry: vi.fn(),
}));

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

const mockTx = {
  insert: vi.fn().mockReturnValue({ values: mockValues }),
  delete: vi.fn().mockReturnValue({ where: mockDeleteWhere }),
};

vi.mock("../../database/client.js", () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
  },
}));

vi.mock("./tools.schema.js", () => ({
  tools: { name: "name" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  notInArray: vi.fn((...args: unknown[]) => ({ type: "notInArray", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  not: vi.fn((...args: unknown[]) => ({ type: "not", args })),
  like: vi.fn((...args: unknown[]) => ({ type: "like", args })),
}));

import { like } from "drizzle-orm";
import { syncToolsToDb } from "./tools-sync.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset chainable mocks
  mockOnConflictDoUpdate.mockResolvedValue(undefined);
  mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  mockTx.insert.mockReturnValue({ values: mockValues });
  mockDeleteWhere.mockResolvedValue(undefined);
  mockTx.delete.mockReturnValue({ where: mockDeleteWhere });
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

  it("never hard-deletes namespaced (plugin/agent) rows — excludes %:% not just agent:%", async () => {
    // A plugin absent from the registry this boot (version skew / import crash)
    // must NOT have its tools deleted, else the instance_tools FK cascade wipes
    // customer enablement. The static delete filters on `%:%` (any namespaced
    // name), never the narrow `agent:%`.
    const registry = new Map([["coreTool", toolDef("coreTool")]]);
    mockGetToolRegistry.mockReturnValue(registry);

    await syncToolsToDb();

    const likePatterns = vi.mocked(like).mock.calls.map((c) => c[1]);
    expect(likePatterns).toContain("%:%"); // any namespaced name, not just agent:%
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
