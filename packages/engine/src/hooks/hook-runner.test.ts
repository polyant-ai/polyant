// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getEnabledHooksMock, executeMock, auditLogMock, recordExecutionMock } = vi.hoisted(() => ({
  getEnabledHooksMock: vi.fn(),
  executeMock: vi.fn(),
  auditLogMock: vi.fn(),
  recordExecutionMock: vi.fn(),
}));

vi.mock("./hooks.store.js", () => ({
  getEnabledHooks: getEnabledHooksMock,
}));

vi.mock("./hook-executions.store.js", () => ({
  recordHookExecution: recordExecutionMock,
}));

vi.mock("./actions/function-action.js", () => ({
  functionActionExecutor: { execute: executeMock },
}));

vi.mock("../audit/audit-logger.js", () => ({
  createAuditLogger: () => ({ log: auditLogMock }),
}));

import { runHooks, collectInjectContext, hookProvenance, firstRegenerate } from "./hook-runner.js";
import type { HookEventPayload, HookExecutionSummary, HookRunContext, InstanceHookRow } from "./hook-types.js";
import { asInstanceSlug } from "../instances/identifiers.js";

const payload: HookEventPayload = {
  instance: { slug: "demo" },
  conversation: { id: "c1" },
  channel: { type: "whatsapp", id: "+39" },
  user: { name: "P" },
  message: { text: "hi" },
};

const baseCtx: HookRunContext = {
  instanceId: asInstanceSlug("demo"),
  conversationId: "c1",
  secrets: {},
};

function hook(id: string, overrides: Partial<InstanceHookRow> = {}): InstanceHookRow {
  return {
    id,
    instanceId: "u1",
    event: "message_received",
    actionType: "function",
    actionConfig: { functionName: `tool-${id}` },
    enabled: true,
    position: 0,
    timeoutMs: 10_000,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("runHooks", () => {
  beforeEach(() => {
    getEnabledHooksMock.mockReset().mockResolvedValue([]);
    executeMock.mockReset().mockResolvedValue(undefined);
    auditLogMock.mockReset();
    recordExecutionMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("should_execute_hooks_sequentially_in_store_order", async () => {
    const order: string[] = [];
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock.mockImplementation(async (h: InstanceHookRow) => {
      order.push(h.id);
    });
    await runHooks("message_received", payload, baseCtx);
    expect(order).toEqual(["a", "b"]);
    expect(auditLogMock).toHaveBeenCalledTimes(2);
    expect(auditLogMock.mock.calls[0][0]).toMatchObject({ success: true });
  });

  it("should_continue_after_a_failing_hook", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    await runHooks("message_received", payload, baseCtx);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(auditLogMock.mock.calls[0][0]).toMatchObject({ success: false, error: "boom" });
    expect(auditLogMock.mock.calls[1][0]).toMatchObject({ success: true });
  });

  it("should_timeout_a_slow_hook_and_continue", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("slow", { timeoutMs: 1000 }), hook("fast")]);
    vi.useFakeTimers();
    executeMock.mockImplementation((h: InstanceHookRow) =>
      h.id === "slow" ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    const run = runHooks("message_received", payload, baseCtx);
    await vi.advanceTimersByTimeAsync(1001);
    await run;
    vi.useRealTimers();
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(auditLogMock.mock.calls[0][0].success).toBe(false);
    expect(auditLogMock.mock.calls[0][0].error).toMatch(/timed out/);
  });

  it("should_abort_the_signal_handed_to_a_timed_out_hook", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("slow", { timeoutMs: 1000 })]);
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    executeMock.mockImplementation((_h, _p, ctx: HookRunContext) => {
      seen = ctx.abortSignal;
      return new Promise<void>(() => {});
    });
    const run = runHooks("message_received", payload, baseCtx);
    await vi.advanceTimersByTimeAsync(1001);
    await run;
    vi.useRealTimers();
    // The rejection unblocks the runner; the signal is what tells the hook.
    expect(seen?.aborted).toBe(true);
  });

  it("should_ignore_a_state_write_from_a_hook_that_already_timed_out", async () => {
    const set = vi.fn();
    const state = { get: () => undefined, set, getAll: () => ({}), delete: vi.fn(), channel: undefined };
    getEnabledHooksMock.mockResolvedValue([hook("slow", { timeoutMs: 1000 })]);
    vi.useFakeTimers();
    let lateWrite: (() => void) | undefined;
    executeMock.mockImplementation((_h, _p, ctx: HookRunContext) => {
      lateWrite = () => ctx.state!.set("k", "v");
      return new Promise<void>(() => {});
    });
    const run = runHooks("message_received", payload, { ...baseCtx, state });
    await vi.advanceTimersByTimeAsync(1001);
    await run;
    vi.useRealTimers();
    // The abandoned hook finally gets around to writing — into a fenced view.
    lateWrite!();
    expect(set).not.toHaveBeenCalled();
  });

  it("should_still_allow_state_writes_while_the_hook_is_within_its_deadline", async () => {
    const set = vi.fn();
    const state = { get: () => undefined, set, getAll: () => ({}), delete: vi.fn(), channel: undefined };
    getEnabledHooksMock.mockResolvedValue([hook("a")]);
    executeMock.mockImplementation(async (_h, _p, ctx: HookRunContext) => {
      ctx.state!.set("k", "v");
    });
    await runHooks("message_received", payload, { ...baseCtx, state });
    expect(set).toHaveBeenCalledWith("k", "v");
  });

  it("should_skip_remaining_hooks_when_aborted", async () => {
    const controller = new AbortController();
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock.mockImplementation(async () => {
      controller.abort();
    });
    await runHooks("message_received", payload, { ...baseCtx, abortSignal: controller.signal });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("should_stop_the_chain_and_surface_the_halt", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock.mockImplementationOnce(
      async (
        _h: InstanceHookRow,
        _p: HookEventPayload,
        _c: HookRunContext,
        capture: (data: { halt?: { message: string } }) => void,
      ) => {
        capture({ halt: { message: "stop" } });
      },
    );
    const summaries = await runHooks("message_received", payload, baseCtx);
    expect(executeMock).toHaveBeenCalledTimes(1); // second hook never ran
    expect(summaries).toHaveLength(1);
    expect(summaries[0].halt).toEqual({ message: "stop" });
  });

  it("should_skip_unknown_action_types", async () => {
    getEnabledHooksMock.mockResolvedValue([
      hook("x", { actionType: "future_thing" as InstanceHookRow["actionType"] }),
    ]);
    await runHooks("message_received", payload, baseCtx);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("should_swallow_store_errors", async () => {
    getEnabledHooksMock.mockRejectedValue(new Error("db down"));
    await expect(runHooks("message_received", payload, baseCtx)).resolves.toEqual([]);
  });

  it("should_record_execution_telemetry_for_success_and_failure", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));
    await runHooks("message_received", payload, baseCtx);
    expect(recordExecutionMock).toHaveBeenCalledTimes(2);
    expect(recordExecutionMock.mock.calls[0][0]).toMatchObject({
      instanceId: "demo",
      conversationId: "c1",
      hookId: "a",
      event: "message_received",
      actionType: "function",
      toolName: "tool-a",
      success: true,
    });
    expect(recordExecutionMock.mock.calls[1][0]).toMatchObject({
      hookId: "b",
      toolName: "tool-b",
      success: false,
      error: "boom",
    });
  });

  it("should_not_fail_the_run_when_telemetry_write_fails", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("a")]);
    recordExecutionMock.mockRejectedValue(new Error("insert failed"));
    await runHooks("message_received", payload, baseCtx);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("should_return_execution_summaries", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));
    const summaries = await runHooks("message_received", payload, baseCtx);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      hookId: "a",
      event: "message_received",
      actionType: "function",
      toolName: "tool-a",
      success: true,
    });
    expect(summaries[1]).toMatchObject({ hookId: "b", success: false, error: "boom" });
    expect(typeof summaries[0].durationMs).toBe("number");
  });

  it("should_propagate_captured_args_and_result_to_summary_and_telemetry", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("a")]);
    executeMock.mockImplementation(
      async (
        _h: InstanceHookRow,
        _p: HookEventPayload,
        _c: HookRunContext,
        capture: (data: { args?: Record<string, unknown>; result?: string }) => void,
      ) => {
        capture({ args: { q: "+39" } });
        capture({ result: '{"ok":true}' });
      },
    );
    const summaries = await runHooks("message_received", payload, baseCtx);
    expect(summaries[0]).toMatchObject({ args: { q: "+39" }, result: '{"ok":true}' });
    expect(recordExecutionMock.mock.calls[0][0]).toMatchObject({
      args: { q: "+39" },
      result: '{"ok":true}',
    });
  });

  it("should_return_empty_array_when_no_hooks_or_store_error", async () => {
    expect(await runHooks("message_received", payload, baseCtx)).toEqual([]);
    getEnabledHooksMock.mockRejectedValue(new Error("db down"));
    expect(await runHooks("message_received", payload, baseCtx)).toEqual([]);
  });
});

describe("firstRegenerate", () => {
  function summary(overrides: Partial<HookExecutionSummary & { regenerate?: { reason?: string } }>): HookExecutionSummary {
    return {
      hookId: "h",
      event: "message_received",
      actionType: "function",
      toolName: "t",
      success: true,
      durationMs: 1,
      ...overrides,
    } as HookExecutionSummary;
  }

  it("returns the first regenerate signal across summaries", () => {
    expect(
      firstRegenerate([summary({}), summary({ regenerate: { reason: "dirty" } })]),
    ).toEqual({ reason: "dirty" });
  });

  it("returns undefined when no summary requested regenerate", () => {
    expect(firstRegenerate([summary({}), summary({})])).toBeUndefined();
  });
});

describe("collectInjectContext", () => {
  function summary(overrides: Partial<HookExecutionSummary>): HookExecutionSummary {
    return {
      hookId: "h",
      event: "message_received",
      actionType: "function",
      toolName: "t",
      success: true,
      durationMs: 1,
      ...overrides,
    };
  }

  it("should_return_non_empty_inject_context_strings_in_order", () => {
    expect(
      collectInjectContext([
        summary({ injectContext: "first" }),
        summary({}),
        summary({ injectContext: "second" }),
      ]),
    ).toEqual(["first", "second"]);
  });

  it("should_drop_empty_strings_and_return_empty_when_none_present", () => {
    expect(collectInjectContext([summary({}), summary({ injectContext: "" })])).toEqual([]);
    expect(collectInjectContext([])).toEqual([]);
  });
});

describe("hookProvenance", () => {
  function summary(overrides: Partial<HookExecutionSummary>): HookExecutionSummary {
    return {
      hookId: "h",
      event: "message_received",
      actionType: "function",
      toolName: "t",
      success: true,
      durationMs: 1,
      ...overrides,
    };
  }

  it("should_return_undefined_when_no_replace_or_halt", () => {
    expect(hookProvenance([summary({}), summary({ injectContext: "x" })])).toBeUndefined();
    expect(hookProvenance([])).toBeUndefined();
  });

  it("should_badge_the_replace_hook_by_name", () => {
    expect(
      hookProvenance([summary({}), summary({ toolName: "replacer", replaceResponse: { message: "new" } })]),
    ).toEqual({ source: "hook", hookName: "replacer" });
  });

  it("should_badge_the_halt_hook_by_name", () => {
    expect(hookProvenance([summary({ toolName: "halter", halt: { message: "stop" } })])).toEqual({
      source: "hook",
      hookName: "halter",
    });
  });

  it("should_prefer_replace_over_halt", () => {
    expect(
      hookProvenance([
        summary({ toolName: "halter", halt: { message: "stop" } }),
        summary({ toolName: "replacer", replaceResponse: { message: "new" } }),
      ]),
    ).toEqual({ source: "hook", hookName: "replacer" });
  });

  it("should_fall_back_to_generic_name_when_toolName_empty", () => {
    expect(hookProvenance([summary({ toolName: "", replaceResponse: { message: "new" } })])).toEqual({
      source: "hook",
      hookName: "hook",
    });
  });
});
