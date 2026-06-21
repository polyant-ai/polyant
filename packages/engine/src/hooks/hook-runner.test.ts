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

vi.mock("./actions/tool-action.js", () => ({
  toolActionExecutor: { execute: executeMock },
}));

vi.mock("../audit/audit-logger.js", () => ({
  createAuditLogger: () => ({ log: auditLogMock }),
}));

import { runHooks } from "./hook-runner.js";
import type { HookEventPayload, HookRunContext, InstanceHookRow } from "./hook-types.js";
import { asAgentSlug } from "../instances/identifiers.js";

const payload: HookEventPayload = {
  instance: { slug: "demo" },
  conversation: { id: "c1" },
  channel: { type: "whatsapp", id: "+39" },
  user: { name: "P" },
  message: { text: "hi" },
};

const baseCtx: HookRunContext = {
  agentId: asAgentSlug("demo"),
  conversationId: "c1",
  secrets: {},
};

function hook(id: string, overrides: Partial<InstanceHookRow> = {}): InstanceHookRow {
  return {
    id,
    agentId: "u1",
    event: "message_received",
    actionType: "tool",
    actionConfig: { toolName: `tool-${id}`, args: {} },
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

  it("should_skip_remaining_hooks_when_aborted", async () => {
    const controller = new AbortController();
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock.mockImplementation(async () => {
      controller.abort();
    });
    await runHooks("message_received", payload, { ...baseCtx, abortSignal: controller.signal });
    expect(executeMock).toHaveBeenCalledTimes(1);
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
      agentId: "demo",
      conversationId: "c1",
      hookId: "a",
      event: "message_received",
      actionType: "tool",
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
      actionType: "tool",
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
