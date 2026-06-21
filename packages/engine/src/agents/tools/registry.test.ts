// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { asAgentSlug } from "../../instances/identifiers.js";

// ---------------------------------------------------------------------------
// Mock the `ai` module so we never invoke real Vercel AI SDK tooling.
// The mock `tool` function returns a tagged object for easy assertions.
// ---------------------------------------------------------------------------
vi.mock("ai", () => ({
  tool: vi.fn((opts: any) => ({ _type: "mock-tool", ...opts })),
}));

// ---------------------------------------------------------------------------
// Mock `fs` so loadAllTools() does not scan the real filesystem.
// ---------------------------------------------------------------------------
vi.mock("fs", () => ({
  readdirSync: vi.fn(() => []),
}));

import { tool as aiTool } from "ai";
import { readdirSync } from "fs";
import {
  registerTool,
  getToolRegistry,
  buildTool,
  listAvailableTools,
  loadAllTools,
  normalizeRequiredSecrets,
  requiredSecretKeys,
  fillMissingKeysWithNull,
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

/** Build a minimal ToolDefinition with sensible defaults. */
function makeDef(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: `Description for ${overrides.name}`,
    create: () => ({
      parameters: z.object({ input: z.string() }),
      execute: async (params: any) => ({ echo: params.input }),
    }),
    ...overrides,
  };
}

const noopAudit = { log: () => {} };

const mockCtx: ToolContext = {
  agentId: asAgentSlug("test-instance"),
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
  // registerTool
  // =========================================================================

  describe("registerTool", () => {
    it("registers a tool that is retrievable via getToolRegistry", () => {
      const name = uid("register");
      const def = makeDef({ name });

      registerTool(def);

      const reg = getToolRegistry();
      expect(reg.has(name)).toBe(true);
      expect(reg.get(name)).toBe(def);
    });

    it("throws on duplicate tool name", () => {
      const name = uid("duplicate");
      const def = makeDef({ name });

      registerTool(def);

      expect(() => registerTool(def)).toThrowError(
        `Duplicate tool registration: "${name}" is already registered.`,
      );
    });

    it("throws on duplicate even when definitions differ", () => {
      const name = uid("dup-diff");
      registerTool(makeDef({ name, description: "first" }));

      expect(() =>
        registerTool(makeDef({ name, description: "second" })),
      ).toThrowError(/Duplicate tool registration/);
    });

    it("stores the full definition including optional fields", () => {
      const name = uid("full-def");
      const def = makeDef({
        name,
        category: "network",
        requiredEnv: ["API_KEY"],
        requiredSecrets: ["secret_token"],
      });

      registerTool(def);

      const stored = getToolRegistry().get(name)!;
      expect(stored.category).toBe("network");
      expect(stored.requiredEnv).toEqual(["API_KEY"]);
      expect(stored.requiredSecrets).toEqual(["secret_token"]);
    });
  });

  // =========================================================================
  // getToolRegistry
  // =========================================================================

  describe("getToolRegistry", () => {
    it("returns a Map containing all registered tools", () => {
      const name1 = uid("reg-a");
      const name2 = uid("reg-b");
      registerTool(makeDef({ name: name1 }));
      registerTool(makeDef({ name: name2 }));

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
  // buildTool
  // =========================================================================

  describe("buildTool", () => {
    it("calls def.create with the provided context", () => {
      const name = uid("build-ctx");
      const createSpy = vi.fn().mockReturnValue({
        parameters: z.object({ x: z.number() }),
        execute: async () => "ok",
      });
      const def = makeDef({ name, create: createSpy });

      buildTool(def, mockCtx);

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(mockCtx);
    });

    it("passes description from the definition to ai.tool()", () => {
      const name = uid("build-desc");
      const description = "A very special tool";
      const parameters = z.object({ q: z.string() });
      const execute = async () => "result";

      const def = makeDef({
        name,
        description,
        create: () => ({ parameters, execute }),
      });

      buildTool(def, mockCtx);

      expect(aiTool).toHaveBeenCalledTimes(1);
      // - execute is wrapped by buildTool to add pipelineLog calls
      // - inputSchema is wrapped in z.preprocess to fill missing fields with null
      //   for non-strict models, so we check it's a Zod schema rather than the
      //   exact reference.
      expect(aiTool).toHaveBeenCalledWith({
        description,
        inputSchema: expect.objectContaining({ safeParse: expect.any(Function) }),
        execute: expect.any(Function),
      });
    });

    it("returns the value produced by ai.tool()", () => {
      const name = uid("build-ret");
      const def = makeDef({ name });

      const result = buildTool(def, mockCtx) as any;

      // Our mock of ai.tool returns { _type: "mock-tool", ...opts }
      expect(result._type).toBe("mock-tool");
      expect(result.description).toBe(`Description for ${name}`);
    });

    it("uses description from definition, not from create()", () => {
      const name = uid("build-desc-override");
      const defDescription = "Definition-level description";

      const def: ToolDefinition = {
        name,
        description: defDescription,
        create: () => ({
          parameters: z.object({}),
          execute: async () => null,
        }),
      };

      buildTool(def, mockCtx);

      expect(aiTool).toHaveBeenCalledWith(
        expect.objectContaining({ description: defDescription }),
      );
    });

    it("passes secrets from context through to create()", () => {
      const name = uid("build-secrets");
      const ctxWithSecrets: ToolContext = {
        ...mockCtx,
        secrets: { API_KEY: "sk-test-123" },
      };
      const createSpy = vi.fn().mockReturnValue({
        parameters: z.object({}),
        execute: async () => null,
      });
      const def = makeDef({ name, create: createSpy });

      buildTool(def, ctxWithSecrets);

      expect(createSpy).toHaveBeenCalledWith(ctxWithSecrets);
      expect(createSpy.mock.calls[0][0].secrets).toEqual({ API_KEY: "sk-test-123" });
    });

    // -----------------------------------------------------------------------
    // runtime preprocess: fill missing fields with null
    // -----------------------------------------------------------------------

    it("fills missing nullable fields with null at runtime parse", () => {
      const name = uid("build-runtime-fill");
      const parameters = z.object({
        action: z.string(),
        contactId: z.string().nullable(),
        firstName: z.string().nullable(),
      });
      const def: ToolDefinition = {
        name,
        description: "fill missing test",
        create: () => ({ parameters, execute: async (p) => p }),
      };

      buildTool(def, mockCtx);
      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as { inputSchema: z.ZodTypeAny };
      const result = call.inputSchema.safeParse({ action: "create", firstName: "Mario" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ action: "create", firstName: "Mario", contactId: null });
      }
    });

    // -----------------------------------------------------------------------
    // inputExamples
    // -----------------------------------------------------------------------

    it("appends valid inputExamples to the description", () => {
      const name = uid("build-examples-valid");
      const parameters = z.object({ query: z.string(), limit: z.number().optional() });
      const def: ToolDefinition = {
        name,
        description: "Base description.",
        inputExamples: [
          { label: "Simple search", input: { query: "test" } },
          { label: "With limit", input: { query: "test", limit: 5 } },
        ],
        create: () => ({ parameters, execute: async () => null }),
      };

      buildTool(def, mockCtx);

      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as any;
      expect(call.description).toContain("Base description.");
      expect(call.description).toContain("Input examples:");
      expect(call.description).toContain("Simple search:");
      expect(call.description).toContain('"query":"test"');
      expect(call.description).toContain("With limit:");
      expect(call.description).toContain('"limit":5');
    });

    it("skips invalid examples and keeps valid ones", () => {
      const name = uid("build-examples-mixed");
      const parameters = z.object({ query: z.string() });
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const def: ToolDefinition = {
        name,
        description: "Base.",
        inputExamples: [
          { label: "Valid", input: { query: "ok" } },
          { label: "Invalid", input: { query: 123 } }, // wrong type
        ],
        create: () => ({ parameters, execute: async () => null }),
      };

      buildTool(def, mockCtx);

      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as any;
      expect(call.description).toContain("Valid:");
      expect(call.description).not.toContain("Invalid:");
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(`example "Invalid" failed validation`),
        expect.anything(),
      );
      consoleSpy.mockRestore();
    });

    it("does not modify description when inputExamples is undefined", () => {
      const name = uid("build-examples-undef");
      const def = makeDef({ name, description: "Unchanged." });

      buildTool(def, mockCtx);

      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as any;
      expect(call.description).toBe("Unchanged.");
    });

    it("does not append examples block when all examples are invalid", () => {
      const name = uid("build-examples-all-invalid");
      const parameters = z.object({ num: z.number() });
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const def: ToolDefinition = {
        name,
        description: "Original.",
        inputExamples: [
          // Examples are validated against the partial schema, so missing
          // required fields don't reject them — both inputs use type mismatches.
          { label: "Bad1", input: { num: "not-a-number" } },
          { label: "Bad2", input: { num: true } },
        ],
        create: () => ({ parameters, execute: async () => null }),
      };

      buildTool(def, mockCtx);

      const call = vi.mocked(aiTool).mock.calls.at(-1)![0] as any;
      expect(call.description).toBe("Original.");
      expect(call.description).not.toContain("Input examples:");
      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // listAvailableTools
  // =========================================================================

  describe("listAvailableTools", () => {
    it("returns array entries with name, description, and category", () => {
      const name = uid("list-cat");
      registerTool(makeDef({ name, category: "io", description: "An IO tool" }));

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
      registerTool(makeDef({ name, requiredSecrets: ["legacy_key"] }));

      const entry = listAvailableTools().find((t) => t.name === name)!;
      expect(entry.requiredSecrets).toEqual([{ key: "legacy_key", type: "text", sensitive: true }]);
    });

    it("passes through rich select specs untouched", () => {
      const name = uid("list-normalize-select");
      registerTool(
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
      registerTool(
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
      registerTool(makeDef({ name }));

      const list = listAvailableTools();
      const entry = list.find((t) => t.name === name);

      expect(entry).toBeDefined();
      expect(entry!.category).toBe("general");
    });

    it("includes all registered tools", () => {
      const names = [uid("list-a"), uid("list-b"), uid("list-c")];
      names.forEach((n) => registerTool(makeDef({ name: n })));

      const list = listAvailableTools();
      const listedNames = list.map((t) => t.name);

      for (const n of names) {
        expect(listedNames).toContain(n);
      }
    });

    it("should exclude harness tools from listAvailableTools", () => {
      const name = uid("list-harness-excluded");
      registerTool(makeDef({ name, harness: true, category: "room" } as any));

      const list = listAvailableTools();
      const entry = list.find((t) => t.name === name);

      expect(entry).toBeUndefined();
    });

    it("should include non-harness tools in listAvailableTools", () => {
      const name = uid("list-non-harness");
      registerTool(makeDef({ name, category: "general" }));

      const list = listAvailableTools();
      const entry = list.find((t) => t.name === name);

      expect(entry).toBeDefined();
      expect(entry!.name).toBe(name);
    });

    it("does not expose create function or requiredEnv, but does expose requiredSecrets", () => {
      const name = uid("list-no-internals");
      registerTool(makeDef({ name, requiredEnv: ["SECRET"], requiredSecrets: ["key"] }));

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

    it("registerTool rejects malformed specs at registration time", () => {
      const name = uid("register-bad-spec");
      expect(() =>
        registerTool(
          makeDef({
            name,
            requiredSecrets: [{ key: "x", type: "select", choices: [] }],
          }),
        ),
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

    it("registerTool's error message includes the tool name", () => {
      const name = uid("named-bad-spec");
      expect(() =>
        registerTool(
          makeDef({
            name,
            requiredSecrets: [""],
          }),
        ),
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
      registerTool(
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
      registerTool(makeDef({ name, requiredEnv: ["API_PORT"] }));

      mockReaddirSync.mockReturnValue([] as any);

      await loadAllTools();

      expect(getToolRegistry().has(name)).toBe(true);
    });

    it("keeps tools that have no requiredEnv at all", async () => {
      const name = uid("load-no-env");
      registerTool(makeDef({ name }));

      mockReaddirSync.mockReturnValue([] as any);

      await loadAllTools();

      expect(getToolRegistry().has(name)).toBe(true);
    });

    it("keeps tools with an empty requiredEnv array", async () => {
      const name = uid("load-empty-env");
      registerTool(makeDef({ name, requiredEnv: [] }));

      mockReaddirSync.mockReturnValue([] as any);

      await loadAllTools();

      expect(getToolRegistry().has(name)).toBe(true);
    });

    it("logs which env vars are missing for pruned tools", async () => {
      const name = uid("load-log-missing");
      registerTool(
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

      registerTool(makeDef({ name: goodName, requiredEnv: ["API_PORT"] }));
      registerTool(makeDef({ name: badName, requiredEnv: ["NONEXISTENT_VAR_ZZZ"] }));

      mockReaddirSync.mockReturnValue([] as any);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      await loadAllTools();

      expect(getToolRegistry().has(goodName)).toBe(true);
      expect(getToolRegistry().has(badName)).toBe(false);
    });
  });

  describe("fillMissingKeysWithNull", () => {
    it("should_fill_missing_object_keys_with_null", () => {
      const schema = z.object({ a: z.string().nullable(), b: z.number().nullable() });
      expect(fillMissingKeysWithNull(schema, { a: "x" })).toEqual({ a: "x", b: null });
    });

    it("should_pass_through_non_object_schema_or_value", () => {
      const schema = z.object({ a: z.string().nullable() });
      expect(fillMissingKeysWithNull(z.string(), "v")).toBe("v");
      expect(fillMissingKeysWithNull(schema, null)).toBe(null);
      expect(fillMissingKeysWithNull(schema, [1])).toEqual([1]);
    });
  });
});
