// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HookFunctionDefinition, HookResult, RequiredSecretSpec } from "@polyant-ai/plugin-sdk";
import type { InstanceHookRow, HookRunContext, HookEventPayload, HookExecutionCapture } from "../hook-types.js";
import { asAgentSlug } from "../../instances/identifiers.js";

// --- mocks --------------------------------------------------------------------
const { mockGetHookRegistry } = vi.hoisted(() => ({ mockGetHookRegistry: vi.fn() }));
vi.mock("../hook-registry.js", () => ({ getHookRegistry: mockGetHookRegistry }));

vi.mock("../../audit/audit-logger.js", () => ({ createAuditLogger: () => ({ log: vi.fn() }) }));

// buildHookContext is stubbed to a passthrough so this suite exercises ONLY the
// executor's registry-lookup + control-return mapping, not context assembly.
const { mockBuildHookContext } = vi.hoisted(() => ({ mockBuildHookContext: vi.fn((..._args: unknown[]) => ({})) }));
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
  instanceId: asAgentSlug("acme"),
  conversationId: "conv-1",
  secrets: {},
};

function def(overrides: Partial<HookFunctionDefinition> & { handler: () => Promise<HookResult> | HookResult }): HookFunctionDefinition {
  return { name: "fn", description: "", requiredSecrets: [], ...overrides };
}

function run(hookDef: HookFunctionDefinition | undefined, functionName = "fn", ctxOverride: HookRunContext = ctx) {
  mockGetHookRegistry.mockReturnValue(new Map(hookDef ? [[functionName, hookDef]] : []));
  const captured: HookExecutionCapture = {};
  const capture = (d: HookExecutionCapture) => Object.assign(captured, d);
  return { promise: functionActionExecutor.execute(hookRow(functionName), payload, ctxOverride, capture), captured };
}

const secret = (key: string, optional = false): RequiredSecretSpec => ({ key, type: "text", optional, sensitive: true });

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

  it("should_drop_regenerate_and_warn_when_mutatesResponse_not_declared", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { promise, captured } = run(def({ mutatesResponse: false, handler: () => ({ regenerate: { reason: "dirty" } }) }));
    await promise;
    // Hard gate: regenerate replays the whole turn, so it is DROPPED (not honored) when
    // the hook forgot mutatesResponse — never a surprise multi-pass cost.
    expect(captured.regenerate).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mutatesResponse"));
    warn.mockRestore();
  });

  it("should_capture_regenerate_without_warning_when_mutatesResponse_declared", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { promise, captured } = run(def({ mutatesResponse: true, handler: () => ({ regenerate: {} }) }));
    await promise;
    expect(captured.regenerate).toEqual({});
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

  it("should_throw_when_a_required_secret_is_missing", async () => {
    const handler = vi.fn((): HookResult => undefined);
    const { promise } = run(def({ requiredSecrets: [secret("api_key")], handler }));
    await expect(promise).rejects.toThrow(/missing required secret/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("should_run_when_the_only_missing_secret_is_optional", async () => {
    const handler = vi.fn((): HookResult => undefined);
    const { promise } = run(def({ requiredSecrets: [secret("api_key", true)], handler }));
    await promise;
    expect(handler).toHaveBeenCalled();
  });

  it("should_run_when_all_required_secrets_are_present", async () => {
    const handler = vi.fn((): HookResult => undefined);
    const ctxWithSecret: HookRunContext = { ...ctx, secrets: { api_key: "sk-1" } };
    const { promise } = run(def({ requiredSecrets: [secret("api_key")], handler }), "fn", ctxWithSecret);
    await promise;
    expect(handler).toHaveBeenCalled();
  });

  it("should_scope_secrets_to_the_keys_the_hook_declares", async () => {
    const ctxWithSecrets: HookRunContext = { ...ctx, secrets: { api_key: "sk-1", unrelated: "nope" } };
    const { promise } = run(def({ requiredSecrets: [secret("api_key")], handler: () => undefined }), "fn", ctxWithSecrets);
    await promise;
    const passedCtx = mockBuildHookContext.mock.calls[0][2] as HookRunContext;
    expect(passedCtx.secrets).toEqual({ api_key: "sk-1" });
  });

  it("should_pass_empty_secrets_when_the_hook_declares_none", async () => {
    const ctxWithSecrets: HookRunContext = { ...ctx, secrets: { api_key: "sk-1" } };
    const { promise } = run(def({ requiredSecrets: [], handler: () => undefined }), "fn", ctxWithSecrets);
    await promise;
    const passedCtx = mockBuildHookContext.mock.calls[0][2] as HookRunContext;
    expect(passedCtx.secrets).toEqual({});
  });
});
