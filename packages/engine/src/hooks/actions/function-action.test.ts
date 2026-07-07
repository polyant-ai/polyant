// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HookFunctionDefinition, HookResult } from "@polyant-ai/plugin-sdk";
import type { InstanceHookRow, HookRunContext, HookEventPayload, HookExecutionCapture } from "../hook-types.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

// --- mocks --------------------------------------------------------------------
const { mockGetHookRegistry } = vi.hoisted(() => ({ mockGetHookRegistry: vi.fn() }));
vi.mock("../hook-registry.js", () => ({ getHookRegistry: mockGetHookRegistry }));

vi.mock("../../audit/audit-logger.js", () => ({ createAuditLogger: () => ({ log: vi.fn() }) }));

// buildHookContext is stubbed to a passthrough so this suite exercises ONLY the
// executor's registry-lookup + control-return mapping, not context assembly.
const { mockBuildHookContext } = vi.hoisted(() => ({ mockBuildHookContext: vi.fn(() => ({})) }));
vi.mock("../hook-context.js", () => ({ buildHookContext: mockBuildHookContext }));

const { functionActionExecutor } = await import("./function-action.js");

// --- fixtures -----------------------------------------------------------------
function hookRow(functionName?: string): InstanceHookRow {
  return {
    id: "hook-1",
    instanceId: "acme",
    event: "message_received",
    actionType: "function",
    // The undefined branch simulates a malformed DB row (no functionName) to
    // exercise the executor's guard — cast past the now-required field.
    actionConfig: functionName === undefined ? ({} as InstanceHookRow["actionConfig"]) : { functionName },
    enabled: true,
    position: 0,
    timeoutMs: 10000,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const payload: HookEventPayload = {
  instance: { slug: "acme" },
  conversation: { id: "conv-1" },
  channel: { type: "web", id: "web-1" },
  user: { name: "Alice" },
  message: { text: "hi" },
};

const ctx: HookRunContext = {
  instanceId: asInstanceSlug("acme"),
  conversationId: "conv-1",
  secrets: {},
};

function def(overrides: Partial<HookFunctionDefinition> & { handler: () => Promise<HookResult> | HookResult }): HookFunctionDefinition {
  return { name: "fn", description: "", requiredSecrets: [], ...overrides };
}

function run(hookDef: HookFunctionDefinition | undefined, functionName = "fn") {
  mockGetHookRegistry.mockReturnValue(new Map(hookDef ? [[functionName, hookDef]] : []));
  const captured: HookExecutionCapture = {};
  const capture = (d: HookExecutionCapture) => Object.assign(captured, d);
  return { promise: functionActionExecutor.execute(hookRow(functionName), payload, ctx, capture), captured };
}

describe("functionActionExecutor", () => {
  beforeEach(() => {
    mockGetHookRegistry.mockReset();
    mockBuildHookContext.mockClear();
  });

  it("should_capture_halt_when_handler_returns_halt", async () => {
    const { promise, captured } = run(def({ handler: () => ({ halt: { message: "no" } }) }));
    await promise;
    expect(captured.halt).toEqual({ message: "no" });
    expect(captured.replaceResponse).toBeUndefined();
  });

  it("should_capture_replaceResponse_and_warn_when_mutatesResponse_not_declared", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { promise, captured } = run(def({ mutatesResponse: false, handler: () => ({ replaceResponse: { message: "x" } }) }));
    await promise;
    expect(captured.replaceResponse).toEqual({ message: "x" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mutatesResponse"));
    warn.mockRestore();
  });

  it("should_not_warn_when_mutatesResponse_declared_true", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { promise, captured } = run(def({ mutatesResponse: true, handler: () => ({ replaceResponse: { message: "x" } }) }));
    await promise;
    expect(captured.replaceResponse).toEqual({ message: "x" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("should_capture_injectContext_when_handler_returns_it", async () => {
    const { promise, captured } = run(def({ handler: () => ({ injectContext: "ctx" }) }));
    await promise;
    expect(captured.injectContext).toBe("ctx");
  });

  it("should_no_op_when_handler_returns_void", async () => {
    const { promise, captured } = run(def({ handler: () => undefined }));
    await promise;
    expect(captured).toEqual({});
  });

  it("should_throw_when_functionName_is_not_registered", async () => {
    // Registry is empty for the looked-up name.
    const { promise } = run(undefined);
    await expect(promise).rejects.toThrow(/not registered/);
  });

  it("should_throw_when_functionName_is_missing", async () => {
    mockGetHookRegistry.mockReturnValue(new Map());
    const captured: HookExecutionCapture = {};
    await expect(
      functionActionExecutor.execute(hookRow(undefined), payload, ctx, (d) => Object.assign(captured, d)),
    ).rejects.toThrow(/functionName/);
  });
});
