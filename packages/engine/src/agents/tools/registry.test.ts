// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { asInstanceSlug } from "../../instances/identifiers.js";

// ---------------------------------------------------------------------------
// Mock the `ai` module so we never invoke real Vercel AI SDK tooling.
// The mock `tool` function returns a tagged object for easy assertions.
// ---------------------------------------------------------------------------
vi.mock("ai", () => ({
  tool: vi.fn((opts: any) => ({ _type: "mock-tool", ...opts })),
  jsonSchema: vi.fn((schema: any, opts: any) => ({ _type: "mock-json-schema", schema, opts })),
}));

// ---------------------------------------------------------------------------
// Mock `fs` so loadAllTools() does not scan the real filesystem.
// existsSync: true only for the core tools dir (so importRoot scans it) and
// false for the convention plugins dir (so no plugin roots are resolved).
// readFileSync: a stub package.json for the lazy engine-version read.
// ---------------------------------------------------------------------------
vi.mock("fs", () => ({
  existsSync: vi.fn((p: unknown) => /agents[/\\]tools$/.test(String(p))),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => JSON.stringify({ version: "0.1.0" })),
}));

import { tool as aiTool } from "ai";
import { readdirSync } from "fs";
import { defineTool } from "@polyant-ai/plugin-sdk";
import {
  _registerToolForTests,
  getToolRegistry,
  buildTool,
  listAvailableTools,
  loadAllTools,
  normalizeRequiredSecrets,
  requiredSecretKeys,
  fillAndValidate,
  scopeSecrets,
  type ToolContext,
  type ToolDefinition,
} from "./registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let uniqueId = 0;

/** Generate a unique tool name so parallel/sequential tests never collide. */
function uid(prefix = "test-tool"): string {
  return `${prefix}-${++uniqueId}-${Date.now()}`;
}

/** Build a minimal serialized ToolDefinition (via defineTool) with sensible
 * defaults. `defineTool` serializes the Zod schema to JSON Schema, exactly like
 * a real tool file's `export default`. */
function makeDef(
  overrides: Partial<Parameters<typeof defineTool>[0]> & { name: string },
): ToolDefinition {
  const { name, description, parameters, execute, ...rest } = overrides;
  return defineTool({
    name,
    description: description ?? `Description for ${name}`,
    parameters: parameters ?? z.object({ input: z.string() }),
    execute: execute ?? (async (params: any) => ({ echo: params.input })),
    ...rest,
  });
}

const noopAudit = { log: () => {} };

const mockCtx: ToolContext = {
  instanceId: asInstanceSlug("test-instance"),
  audit: noopAudit,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // registration (_registerToolForTests → registerSerialized)
  // =========================================================================

  describe("tool registration", () => {
    it("registers a tool that is retrievable via getToolRegistry", () => {
      const name = uid("register");
      const def = makeDef({ name });

      _registerToolForTests(def);

      const reg = getToolRegistry();
      expect(reg.has(name)).toBe(true);
      expect(reg.get(name)).toBe(def);
    });

    it("throws on duplicate tool name", () => {
      const name = uid("duplicate");
      const def = makeDef({ name });

      _registerToolForTests(def);

      expect(() => _registerToolForTests(def)).toThrowError(
        `Duplicate tool registration: "${name}" is already registered.`,
      );
    });

    it("throws on duplicate even when definitions differ", () => {
      const name = uid("dup-diff");
      _registerToolForTests(makeDef({ name, description: "first" }));

      expect(() =>
        _registerToolForTests(makeDef({ name, description: "second" })),
      ).toThrowError(/Duplicate tool registration/);
    });

    it("stores the full definition including optional fields (secrets normalized)", () => {
      const name = uid("full-def");
      const def = makeDef({
        name,
        category: "network",
        requiredEnv: ["API_KEY"],
        requiredSecrets: ["secret_token"],
      });

      _registerToolForTests(def);

      const stored = getToolRegistry().get(name)!;
      expect(stored.category).toBe("network");
      expect(stored.requiredEnv).toEqual(["API_KEY"]);
      // defineTool normalizes bare strings into typed specs.
      expect(stored.requiredSecrets).toEqual([{ key: "secret_token", type: "text", sensitive: true }]);
    });

    it("prefixes the name with the plugin namespace when given", () => {
      const def = makeDef({ name: "ping" });
      _registerToolForTests(def, "sample");
      expect(getToolRegistry().has("sample:ping")).toBe(true);
      expect(getToolRegistry().has("ping")).toBe(false);
    });
  });

  // =========================================================================
  // getToolRegistry
  // =========================================================================

  describe("getToolRegistry", () => {
    it("returns a Map containing all registered tools", () => {
      const name1 = uid("reg-a");
      const name2 = uid("reg-b");
      _registerToolForTests(makeDef({ name: name1 }));
      _registerToolForTests(makeDef({ name: name2 }));

      const reg = getToolRegistry();
      expect(reg.get(name1)).toBeDefined();
      expect(reg.get(name2)).toBeDefined();
    });

    it("returns the same Map reference on repeated calls", () => {
      const a = getToolRegistry();
      const b = getToolRegistry();
      expect(a).toBe(b);
    });
  });

  // =========================================================================
  // buildTool (serialized path — the only path)
  // =========================================================================

  describe("buildTool", () => {
    it("passes description, the serialized inputSchema, and a wrapped execute to ai.tool()", () => {
      const name = uid("build-desc");
      const def = makeDef({ name, description: "A very special tool" });

      buildTool(def, mockCtx);

      expect(aiTool).toHaveBeenCalledTimes(1);
      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as any;
      expect(call.description).toBe("A very special tool");
      // inputSchema is wrapped via ai.jsonSchema(def.inputSchema, { validate }).
      expect(call.inputSchema._type).toBe("mock-json-schema");
      expect(call.inputSchema.schema).toBe(def.inputSchema);
      expect(call.execute).toEqual(expect.any(Function));
    });

    it("returns the value produced by ai.tool()", () => {
      const def = makeDef({ name: uid("build-ret") });
      const result = buildTool(def, mockCtx) as any;
      expect(result._type).toBe("mock-tool");
    });

    it("wraps execute: calls def.execute with (input, ctx) and returns its result", async () => {
      const execute = vi.fn(async (input: any) => ({ got: input.q }));
      const def = makeDef({ name: uid("build-exec"), parameters: z.object({ q: z.string() }), execute });

      buildTool(def, mockCtx);
      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as any;
      const out = await call.execute({ q: "hi" });

      expect(execute).toHaveBeenCalledWith({ q: "hi" }, mockCtx);
      expect(out).toEqual({ got: "hi" });
    });

    it("appends inputExamples to the description (raw, no validation)", () => {
      const def = makeDef({
        name: uid("build-examples"),
        description: "Base description.",
        inputExamples: [
          { label: "Simple search", input: { query: "test" } },
          { label: "With limit", input: { query: "test", limit: 5 } },
        ],
      });

      buildTool(def, mockCtx);

      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as any;
      expect(call.description).toContain("Base description.");
      expect(call.description).toContain("Input examples:");
      expect(call.description).toContain("Simple search:");
      expect(call.description).toContain('"query":"test"');
      expect(call.description).toContain('"limit":5');
    });

    it("does not modify description when inputExamples is undefined", () => {
      const def = makeDef({ name: uid("build-noex"), description: "Unchanged." });

      buildTool(def, mockCtx);

      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as any;
      expect(call.description).toBe("Unchanged.");
    });
  });

  // =========================================================================
  // listAvailableTools
  // =========================================================================

  describe("listAvailableTools", () => {
    it("returns array entries with name, description, and category", () => {
      const name = uid("list-cat");
      _registerToolForTests(makeDef({ name, category: "io", description: "An IO tool" }));

      const list = listAvailableTools();
      const entry = list.find((t) => t.name === name);

      expect(entry).toEqual({
        name,
        description: "An IO tool",
        category: "io",
        requiredSecrets: undefined,
      });
    });

    it("normalizes legacy string requiredSecrets into typed specs", () => {
      const name = uid("list-normalize-legacy");
      _registerToolForTests(makeDef({ name, requiredSecrets: ["legacy_key"] }));

      const entry = listAvailableTools().find((t) => t.name === name)!;
      expect(entry.requiredSecrets).toEqual([{ key: "legacy_key", type: "text", sensitive: true }]);
    });

    it("passes through rich select specs untouched", () => {
      const name = uid("list-normalize-select");
      _registerToolForTests(
        makeDef({
          name,
          requiredSecrets: [
            { key: "search_provider", type: "select", choices: ["a", "b"], label: "Provider" },
          ],
        }),
      );

      const entry = listAvailableTools().find((t) => t.name === name)!;
      expect(entry.requiredSecrets).toEqual([
        { key: "search_provider", type: "select", choices: ["a", "b"], label: "Provider", sensitive: false },
      ]);
    });

    it("supports mixed legacy + rich specs in the same tool", () => {
      const name = uid("list-normalize-mixed");
      _registerToolForTests(
        makeDef({
          name,
          requiredSecrets: [
            "plain_token",
            { key: "provider", type: "select", choices: ["x"], optional: true },
          ],
        }),
      );

      const entry = listAvailableTools().find((t) => t.name === name)!;
      expect(entry.requiredSecrets).toEqual([
        { key: "plain_token", type: "text", sensitive: true },
        { key: "provider", type: "select", choices: ["x"], optional: true, sensitive: false },
      ]);
    });

    it("defaults category to 'general' when not specified", () => {
      const name = uid("list-default-cat");
      _registerToolForTests(makeDef({ name }));

      const list = listAvailableTools();
      const entry = list.find((t) => t.name === name);

      expect(entry).toBeDefined();
      expect(entry!.category).toBe("general");
    });

    it("includes all registered tools", () => {
      const names = [uid("list-a"), uid("list-b"), uid("list-c")];
      names.forEach((n) => _registerToolForTests(makeDef({ name: n })));

      const list = listAvailableTools();
      const listedNames = list.map((t) => t.name);

      for (const n of names) {
        expect(listedNames).toContain(n);
      }
    });

    it("should exclude harness tools from listAvailableTools", () => {
      const name = uid("list-harness-excluded");
      _registerToolForTests(makeDef({ name, harness: true, category: "room" } as any));

      const list = listAvailableTools();
      const entry = list.find((t) => t.name === name);

      expect(entry).toBeUndefined();
    });

    it("should include non-harness tools in listAvailableTools", () => {
      const name = uid("list-non-harness");
      _registerToolForTests(makeDef({ name, category: "general" }));

      const list = listAvailableTools();
      const entry = list.find((t) => t.name === name);

      expect(entry).toBeDefined();
      expect(entry!.name).toBe(name);
    });

    it("does not expose create function or requiredEnv, but does expose requiredSecrets", () => {
      const name = uid("list-no-internals");
      _registerToolForTests(makeDef({ name, requiredEnv: ["SECRET"], requiredSecrets: ["key"] }));

      const list = listAvailableTools();
      const entry = list.find((t) => t.name === name)!;

      expect(entry).toBeDefined();
      expect("create" in entry).toBe(false);
      expect("requiredEnv" in entry).toBe(false);
      // requiredSecrets IS exposed in normalized form (UI uses type/choices/label to render)
      expect(entry.requiredSecrets).toEqual([{ key: "key", type: "text", sensitive: true }]);
    });
  });

  // =========================================================================
  // normalizeRequiredSecrets & requiredSecretKeys
  // =========================================================================

  describe("normalizeRequiredSecrets", () => {
    it("returns empty array for undefined input", () => {
      expect(normalizeRequiredSecrets(undefined)).toEqual([]);
    });

    it("returns empty array for empty input", () => {
      expect(normalizeRequiredSecrets([])).toEqual([]);
    });

    it("converts bare strings into text specs", () => {
      expect(normalizeRequiredSecrets(["a_key", "b_key"])).toEqual([
        { key: "a_key", type: "text", sensitive: true },
        { key: "b_key", type: "text", sensitive: true },
      ]);
    });

    it("passes through select specs with non-empty choices", () => {
      const input = [{ key: "provider", type: "select" as const, choices: ["x", "y"] }];
      expect(normalizeRequiredSecrets(input)).toEqual([
        { key: "provider", type: "select", choices: ["x", "y"], sensitive: false },
      ]);
    });

    it("defaults text fields to sensitive: true", () => {
      expect(normalizeRequiredSecrets(["api_key"])).toEqual([
        { key: "api_key", type: "text", sensitive: true },
      ]);
    });

    it("defaults select fields to sensitive: false", () => {
      expect(
        normalizeRequiredSecrets([{ key: "provider", type: "select", choices: ["a"] }]),
      ).toEqual([{ key: "provider", type: "select", choices: ["a"], sensitive: false }]);
    });

    it("preserves an explicit sensitive override on either type", () => {
      expect(
        normalizeRequiredSecrets([
          { key: "base_url", type: "text", sensitive: false },
          { key: "token", type: "select", choices: ["a"], sensitive: true },
        ]),
      ).toEqual([
        { key: "base_url", type: "text", sensitive: false },
        { key: "token", type: "select", choices: ["a"], sensitive: true },
      ]);
    });

    it("throws on select spec with empty choices", () => {
      expect(() =>
        normalizeRequiredSecrets([{ key: "p", type: "select", choices: [] }]),
      ).toThrowError(/'select' requires non-empty 'choices'/);
    });

    it("throws on select spec with missing choices", () => {
      expect(() =>
        normalizeRequiredSecrets([{ key: "p", type: "select" } as any]),
      ).toThrowError(/'select' requires non-empty 'choices'/);
    });

    it("throws on spec missing the key field", () => {
      expect(() => normalizeRequiredSecrets([{ type: "text" } as any])).toThrowError(
        /missing 'key'/,
      );
    });

    it("defineTool rejects malformed specs at authoring time", () => {
      const name = uid("register-bad-spec");
      expect(() =>
        makeDef({
          name,
          requiredSecrets: [{ key: "x", type: "select", choices: [] }],
        }),
      ).toThrowError(/'select' requires non-empty 'choices'/);
    });

    it("rejects empty-string entries", () => {
      expect(() => normalizeRequiredSecrets([""])).toThrowError(
        /requiredSecrets\[0\] is an empty string/,
      );
    });

    it("includes tool name in errors when provided (F1 — easier debugging)", () => {
      expect(() =>
        normalizeRequiredSecrets([{ key: "p", type: "select", choices: [] }], "myCustomTool"),
      ).toThrowError(/^Tool "myCustomTool": requiredSecrets\[0\] "p"/);

      expect(() =>
        normalizeRequiredSecrets([""], "anotherTool"),
      ).toThrowError(/^Tool "anotherTool": requiredSecrets\[0\] is an empty string/);

      expect(() =>
        normalizeRequiredSecrets([{ type: "text" } as any], "thirdTool"),
      ).toThrowError(/^Tool "thirdTool": requiredSecrets\[0\] missing 'key'/);
    });

    it("defineTool's error message includes the tool name", () => {
      const name = uid("named-bad-spec");
      expect(() =>
        makeDef({
          name,
          requiredSecrets: [""],
        }),
      ).toThrowError(new RegExp(`Tool "${name}": requiredSecrets\\[0\\] is an empty string`));
    });
  });

  describe("requiredSecretKeys", () => {
    it("extracts only the keys from mixed input", () => {
      expect(
        requiredSecretKeys([
          "legacy",
          { key: "provider", type: "select", choices: ["a"] },
          { key: "api_key", type: "text", optional: true },
        ]),
      ).toEqual(["legacy", "provider", "api_key"]);
    });

    it("returns empty array for undefined input", () => {
      expect(requiredSecretKeys(undefined)).toEqual([]);
    });
  });

  // =========================================================================
  // loadAllTools
  // =========================================================================

  describe("loadAllTools", () => {
    const mockReaddirSync = vi.mocked(readdirSync);

    beforeEach(() => {
      mockReaddirSync.mockReset();
    });

    it("scans the tools directory for *.tool.(ts|js) files", async () => {
      mockReaddirSync.mockReturnValue([] as any);

      await loadAllTools();

      expect(mockReaddirSync).toHaveBeenCalledTimes(1);
    });

    it("imports only files matching the *.tool.(ts|js) pattern", async () => {
      // We cannot easily intercept dynamic import() in Vitest, but we can
      // verify the filtering logic by checking which files readdirSync returns
      // and ensuring non-tool files are ignored. We'll set up a scenario
      // where readdirSync returns a mix and assert no errors occur for
      // non-existent tool files (since import() for unknown files would throw
      // if actually called for non-tool files).
      mockReaddirSync.mockReturnValue([
        "registry.ts",
        "registry.test.ts",
        "my-helper.ts",
        "index.ts",
      ] as any);

      // Should complete without error since no *.tool.ts files are found
      await loadAllTools();
    });

    it("prunes tools with missing requiredEnv vars from the registry", async () => {
      const name = uid("load-prune");
      // Register a tool that requires an env var that is NOT set
      _registerToolForTests(
        makeDef({
          name,
          requiredEnv: ["TOTALLY_MISSING_ENV_VAR_XYZ_123"],
        }),
      );

      // Sanity: the tool is in the registry before loadAllTools
      expect(getToolRegistry().has(name)).toBe(true);

      mockReaddirSync.mockReturnValue([] as any);
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await loadAllTools();

      // Tool should have been pruned
      expect(getToolRegistry().has(name)).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Tool "${name}" disabled`),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("TOTALLY_MISSING_ENV_VAR_XYZ_123"),
      );

      consoleSpy.mockRestore();
    });

    it("keeps tools whose requiredEnv vars are all present", async () => {
      const name = uid("load-keep");
      // API_PORT is set in test-setup.ts
      _registerToolForTests(makeDef({ name, requiredEnv: ["API_PORT"] }));

      mockReaddirSync.mockReturnValue([] as any);

      await loadAllTools();

      expect(getToolRegistry().has(name)).toBe(true);
    });

    it("keeps tools that have no requiredEnv at all", async () => {
      const name = uid("load-no-env");
      _registerToolForTests(makeDef({ name }));

      mockReaddirSync.mockReturnValue([] as any);

      await loadAllTools();

      expect(getToolRegistry().has(name)).toBe(true);
    });

    it("keeps tools with an empty requiredEnv array", async () => {
      const name = uid("load-empty-env");
      _registerToolForTests(makeDef({ name, requiredEnv: [] }));

      mockReaddirSync.mockReturnValue([] as any);

      await loadAllTools();

      expect(getToolRegistry().has(name)).toBe(true);
    });

    it("logs which env vars are missing for pruned tools", async () => {
      const name = uid("load-log-missing");
      _registerToolForTests(
        makeDef({
          name,
          requiredEnv: ["MISSING_A_XYZ", "MISSING_B_XYZ"],
        }),
      );

      mockReaddirSync.mockReturnValue([] as any);
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await loadAllTools();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("MISSING_A_XYZ"),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("MISSING_B_XYZ"),
      );

      consoleSpy.mockRestore();
    });

    it("prunes only the tools with missing env vars, not others", async () => {
      const goodName = uid("load-good");
      const badName = uid("load-bad");

      _registerToolForTests(makeDef({ name: goodName, requiredEnv: ["API_PORT"] }));
      _registerToolForTests(makeDef({ name: badName, requiredEnv: ["NONEXISTENT_VAR_ZZZ"] }));

      mockReaddirSync.mockReturnValue([] as any);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await loadAllTools();

      expect(getToolRegistry().has(goodName)).toBe(true);
      expect(getToolRegistry().has(badName)).toBe(false);
    });
  });

  describe("fillAndValidate (serialized-path validation, Zod parity)", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        note: { type: ["string", "null"] }, // nullable
      },
      required: ["name", "count", "note"],
      additionalProperties: false,
    };

    it("accepts a valid input unchanged", () => {
      const r = fillAndValidate(schema, { name: "a", count: 1, note: null });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ name: "a", count: 1, note: null });
    });

    it("fills an omitted nullable key with null and passes", () => {
      const r = fillAndValidate(schema, { name: "a", count: 1 });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.value as Record<string, unknown>).note).toBeNull();
    });

    it("strips a hallucinated extra key (like a non-strict z.object)", () => {
      const r = fillAndValidate(schema, { name: "a", count: 1, note: null, bogus: "x" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).not.toHaveProperty("bogus");
    });

    it("rejects a wrong-typed value (no coercion, like Zod)", () => {
      const r = fillAndValidate(schema, { name: "a", count: "1", note: null });
      expect(r.ok).toBe(false);
    });

    it("rejects a missing required non-nullable key", () => {
      const r = fillAndValidate(schema, { count: 1, note: null }); // name omitted → filled null → invalid
      expect(r.ok).toBe(false);
    });

    it("degrades to fill-only (accept) when the schema does not compile", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const bad = { type: "object", properties: { x: { type: "not-a-real-type" } } };
      const r = fillAndValidate(bad, { x: 1 });
      expect(r.ok).toBe(true); // best-effort: no hard break on an uncompilable schema
      warn.mockRestore();
    });
  });

  describe("scopeSecrets (least-privilege, enforced)", () => {
    const bag = { my_key: "mine", other_key: "theirs" };

    it("keeps declared keys, drops undeclared ones entirely", () => {
      const scoped = scopeSecrets(bag, new Set(["my_key"]))!;
      expect(scoped.my_key).toBe("mine"); // declared → present
      expect(scoped.other_key).toBeUndefined(); // undeclared → absent
      expect("other_key" in scoped).toBe(false);
      expect("my_key" in scoped).toBe(true);
    });

    it("is a fresh object — spread / Object.keys see only the declared subset", () => {
      const scoped = scopeSecrets(bag, new Set(["my_key"]))!;
      expect(Object.keys(scoped)).toEqual(["my_key"]);
      expect({ ...scoped }).toEqual({ my_key: "mine" });
      expect(scoped).not.toBe(bag); // does not mutate/return the original bag
    });

    it("omits a declared key that is not present in the bag", () => {
      const scoped = scopeSecrets({ a: "1" }, new Set(["a", "b"]))!;
      expect(scoped).toEqual({ a: "1" });
    });

    it("returns undefined bag untouched", () => {
      expect(scopeSecrets(undefined, new Set(["x"]))).toBeUndefined();
    });
  });
});
