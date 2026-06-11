// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";

const { registryMock } = vi.hoisted(() => ({ registryMock: new Map<string, unknown>() }));
vi.mock("../agents/tools/registry.js", () => ({
  getToolRegistry: () => registryMock,
}));

import { createHookSchema, updateHookSchema, validateHookTool } from "./hooks.validators.js";

describe("createHookSchema", () => {
  const valid = {
    event: "conversation_start",
    actionConfig: { toolName: "lookup", args: { q: "{{channel.id}}" } },
  };

  it("should_apply_defaults_when_optional_fields_omitted", () => {
    const parsed = createHookSchema.parse(valid);
    expect(parsed).toMatchObject({
      actionType: "tool",
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

  it("should_reject_empty_tool_name", () => {
    expect(
      createHookSchema.safeParse({ ...valid, actionConfig: { toolName: "", args: {} } }).success,
    ).toBe(false);
  });

  it("should_accept_partial_updates", () => {
    expect(updateHookSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateHookSchema.safeParse({}).success).toBe(true);
  });
});

describe("validateHookTool", () => {
  it("should_flag_unregistered_and_meta_tools", () => {
    registryMock.clear();
    registryMock.set("ok", { name: "ok" });
    registryMock.set("meta", { name: "meta", metaTool: true });
    expect(validateHookTool("ok")).toBeNull();
    expect(validateHookTool("nope")).toMatch(/not registered/);
    expect(validateHookTool("meta")).toMatch(/meta-tool/);
  });
});
