// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  collectEnabledToolSecrets,
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
