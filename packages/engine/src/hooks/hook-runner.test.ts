// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getEnabledHooksMock, executeMock, auditLogMock } = vi.hoisted(() => ({
  getEnabledHooksMock: vi.fn(),
  executeMock: vi.fn(),
  auditLogMock: vi.fn(),
}));

vi.mock("./hooks.store.js", () => ({
  getEnabledHooks: getEnabledHooksMock,
}));

vi.mock("./actions/tool-action.js", () => ({
  toolActionExecutor: { execute: executeMock },
}));

vi.mock("../audit/audit-logger.js", () => ({
  createAuditLogger: () => ({ log: auditLogMock }),
}));

import { runHooks } from "./hook-runner.js";
import type { HookEventPayload, HookRunContext, InstanceHookRow } from "./hook-types.js";
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
    await expect(runHooks("message_received", payload, baseCtx)).resolves.toBeUndefined();
  });
});
