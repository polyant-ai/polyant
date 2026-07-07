// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";

const { registryMock } = vi.hoisted(() => ({ registryMock: new Map<string, unknown>() }));
vi.mock("./hook-registry.js", () => ({
  getHookRegistry: () => registryMock,
}));

import { createHookSchema, updateHookSchema, validateHookFunction } from "./hooks.validators.js";

describe("createHookSchema", () => {
  const valid = {
    event: "conversation_start",
    actionConfig: { functionName: "lookup" },
  };

  it("should_apply_defaults_when_optional_fields_omitted", () => {
    const parsed = createHookSchema.parse(valid);
    expect(parsed).toMatchObject({
      actionType: "function",
      enabled: true,
      position: 0,
      timeoutMs: 10_000,
    });
  });

  it("should_reject_unknown_event", () => {
    expect(createHookSchema.safeParse({ ...valid, event: "conversation_idle" }).success).toBe(false);
  });

  it("should_reject_out_of_bounds_timeout", () => {
    expect(createHookSchema.safeParse({ ...valid, timeoutMs: 500 }).success).toBe(false);
    expect(createHookSchema.safeParse({ ...valid, timeoutMs: 60_000 }).success).toBe(false);
  });

  it("should_reject_empty_function_name", () => {
    expect(
      createHookSchema.safeParse({ ...valid, actionConfig: { functionName: "" } }).success,
    ).toBe(false);
  });

  it("should_accept_partial_updates", () => {
    expect(updateHookSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateHookSchema.safeParse({}).success).toBe(true);
  });
});

describe("validateHookFunction", () => {
  it("should_flag_unregistered_functions", () => {
    registryMock.clear();
    registryMock.set("ok", { name: "ok" });
    expect(validateHookFunction("ok")).toBeNull();
    expect(validateHookFunction("nope")).toMatch(/not registered/);
  });
});
