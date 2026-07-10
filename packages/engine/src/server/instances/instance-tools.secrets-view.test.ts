// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  collectEnabledToolSecrets,
  collectInstanceRequiredSecrets,
  enabledHookSecretSources,
  attachReadableValues,
} from "./instance-tools.secrets-view.js";
import type { RequiredSecretSpec } from "../../agents/tools/registry.js";

describe("collectEnabledToolSecrets", () => {
  it("dedupes by key (first-seen wins) and sorts by key", () => {
    const tools = [
      { name: "b", requiredSecrets: [{ key: "z_key", type: "text" as const, sensitive: true }] },
      {
        name: "a",
        requiredSecrets: [
          { key: "a_key", type: "text" as const, sensitive: true },
          { key: "z_key", type: "text" as const, sensitive: false },
        ],
      },
    ];
    const out = collectEnabledToolSecrets(tools, new Set(["a", "b"]));
    expect(out.map((s) => s.key)).toEqual(["a_key", "z_key"]);
    // first-seen wins: z_key kept from tool "b" (sensitive: true)
    expect(out.find((s) => s.key === "z_key")!.sensitive).toBe(true);
  });

  it("treats an empty enabledNames set as all-enabled", () => {
    const tools = [
      { name: "a", requiredSecrets: [{ key: "k", type: "text" as const, sensitive: true }] },
    ];
    expect(collectEnabledToolSecrets(tools, new Set())).toHaveLength(1);
  });

  it("skips disabled tools", () => {
    const tools = [
      { name: "a", requiredSecrets: [{ key: "k", type: "text" as const, sensitive: true }] },
    ];
    expect(collectEnabledToolSecrets(tools, new Set(["other"]))).toEqual([]);
  });

  it("ignores tools without requiredSecrets", () => {
    const tools = [{ name: "a" }];
    expect(collectEnabledToolSecrets(tools, new Set(["a"]))).toEqual([]);
  });
});

describe("collectInstanceRequiredSecrets", () => {
  const toolKey = { key: "tool_key", type: "text" as const, sensitive: true };
  const hookKey = { key: "hook_key", type: "text" as const, sensitive: true };

  it("merges enabled-tool and enabled-hook secrets, sorted by key", () => {
    const tools = [{ name: "t1", requiredSecrets: [toolKey] }];
    const hooks = [{ name: "h1", requiredSecrets: [hookKey] }];
    const out = collectInstanceRequiredSecrets(tools, new Set(["t1"]), hooks);
    expect(out.map((s) => s.key)).toEqual(["hook_key", "tool_key"]);
  });

  it("includes an enabled hook's secrets regardless of tool enablement", () => {
    const tools = [{ name: "t1", requiredSecrets: [toolKey] }];
    const hooks = [{ name: "h1", requiredSecrets: [hookKey] }];
    const out = collectInstanceRequiredSecrets(tools, new Set(["t1"]), hooks);
    expect(out.some((s) => s.key === "hook_key")).toBe(true);
  });

  it("dedupes a key shared by a tool and a hook (tool spec wins)", () => {
    const tools = [{ name: "t1", requiredSecrets: [{ key: "shared", type: "text" as const, sensitive: false }] }];
    const hooks = [{ name: "h1", requiredSecrets: [{ key: "shared", type: "text" as const, sensitive: true }] }];
    const out = collectInstanceRequiredSecrets(tools, new Set(["t1"]), hooks);
    expect(out).toHaveLength(1);
    expect(out[0].sensitive).toBe(false);
  });

  it("returns only tool secrets when there are no enabled hooks", () => {
    const tools = [{ name: "t1", requiredSecrets: [toolKey] }];
    const out = collectInstanceRequiredSecrets(tools, new Set(["t1"]), []);
    expect(out.map((s) => s.key)).toEqual(["tool_key"]);
  });
});

describe("enabledHookSecretSources", () => {
  const lookup = (name: string) =>
    ({
      needs_key: { name: "needs_key", requiredSecrets: [{ key: "k", type: "text" as const, sensitive: true }] },
    })[name];
  const row = (functionName: string, enabled: boolean) => ({ enabled, actionConfig: { functionName } });

  it("maps enabled hooks to their registry secret sources", () => {
    const out = enabledHookSecretSources([row("needs_key", true)], lookup);
    expect(out).toEqual([{ name: "needs_key", requiredSecrets: [{ key: "k", type: "text", sensitive: true }] }]);
  });

  it("skips disabled hooks", () => {
    expect(enabledHookSecretSources([row("needs_key", false)], lookup)).toEqual([]);
  });

  it("skips hooks whose function is not registered", () => {
    expect(enabledHookSecretSources([row("ghost", true)], lookup)).toEqual([]);
  });
});

describe("attachReadableValues", () => {
  const specs: RequiredSecretSpec[] = [
    { key: "base_url", type: "text", sensitive: false },
    { key: "api_key", type: "text", sensitive: true },
    { key: "provider", type: "select", choices: ["a"], sensitive: false },
  ];

  it("echoes currentValue for non-sensitive fields with a stored value", () => {
    const out = attachReadableValues(specs, {
      base_url: "https://api.example.io",
      api_key: "sk-secret",
      provider: "a",
    });
    expect(out.find((s) => s.key === "base_url")).toMatchObject({
      currentValue: "https://api.example.io",
    });
    expect(out.find((s) => s.key === "provider")).toMatchObject({ currentValue: "a" });
  });

  it("never echoes a value for sensitive fields", () => {
    const out = attachReadableValues(specs, { api_key: "sk-secret" });
    expect(out.find((s) => s.key === "api_key")).not.toHaveProperty("currentValue");
  });

  it("omits currentValue for non-sensitive fields with no stored value", () => {
    const out = attachReadableValues(specs, {});
    expect(out.find((s) => s.key === "base_url")).not.toHaveProperty("currentValue");
  });

  it("treats a spec with sensitive omitted as secret (never echoes a value)", () => {
    const out = attachReadableValues([{ key: "x", type: "text" }], { x: "secret" });
    expect(out[0]).not.toHaveProperty("currentValue");
  });
});
