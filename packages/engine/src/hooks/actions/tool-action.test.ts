// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const { registryMock } = vi.hoisted(() => ({
  registryMock: new Map<string, unknown>(),
}));

vi.mock("../../agents/tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/tools/registry.js")>();
  return {
    ...actual,
    getToolRegistry: () => registryMock,
  };
});

vi.mock("../../audit/audit-logger.js", () => ({
  createAuditLogger: () => ({ log: vi.fn() }),
}));

import { toolActionExecutor } from "./tool-action.js";
import type { HookEventPayload, HookExecutionCapture, HookRunContext, InstanceHookRow } from "../hook-types.js";
import { asAgentSlug } from "../../instances/identifiers.js";

const payload: HookEventPayload = {
  instance: { slug: "demo" },
  conversation: { id: "demo:whatsapp:+39" },
  channel: { type: "whatsapp", id: "+39" },
  user: { name: "Paolo" },
  message: { text: "ciao" },
};

const ctx: HookRunContext = {
  agentId: asAgentSlug("demo"),
  conversationId: "demo:whatsapp:+39",
  secrets: { some_key: "v" },
};

function hookFor(toolName: string, args: Record<string, unknown>): InstanceHookRow {
  return {
    id: "h1",
    agentId: "u1",
    event: "conversation_start",
    actionType: "tool",
    actionConfig: { toolName, args },
    enabled: true,
    position: 0,
    timeoutMs: 10_000,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("toolActionExecutor", () => {
  const executeMock = vi.fn();
  let captured: HookExecutionCapture;
  const capture = (data: HookExecutionCapture) => Object.assign(captured, data);

  beforeEach(() => {
    captured = {};
    registryMock.clear();
    executeMock.mockReset().mockResolvedValue({ ok: true });
    registryMock.set("lookup", {
      name: "lookup",
      description: "test tool",
      create: () => ({
        parameters: z.object({ query: z.string().nullable(), limit: z.number().nullable() }),
        execute: executeMock,
      }),
    });
  });

  it("should_render_args_and_execute_tool", async () => {
    await toolActionExecutor.execute(hookFor("lookup", { query: "{{channel.id}}" }), payload, ctx, capture);
    expect(executeMock).toHaveBeenCalledWith({ query: "+39", limit: null });
  });

  it("should_capture_rendered_args_and_serialized_result", async () => {
    await toolActionExecutor.execute(hookFor("lookup", { query: "{{channel.id}}" }), payload, ctx, capture);
    expect(captured.args).toEqual({ query: "+39", limit: null });
    expect(captured.result).toBe(JSON.stringify({ ok: true }));
  });

  it("should_throw_when_tool_not_registered", async () => {
    await expect(
      toolActionExecutor.execute(hookFor("missing", {}), payload, ctx, capture),
    ).rejects.toThrow(/not registered/);
  });

  it("should_throw_when_tool_is_meta_tool", async () => {
    registryMock.set("spawnTask", {
      name: "spawnTask",
      description: "",
      metaTool: true,
      create: () => ({ parameters: z.object({}), execute: executeMock }),
    });
    await expect(
      toolActionExecutor.execute(hookFor("spawnTask", {}), payload, ctx, capture),
    ).rejects.toThrow(/meta-tool/);
  });

  it("should_throw_when_rendered_args_fail_schema_but_still_capture_args", async () => {
    await expect(
      toolActionExecutor.execute(hookFor("lookup", { query: 42 }), payload, ctx, capture),
    ).rejects.toThrow(/schema/);
    expect(executeMock).not.toHaveBeenCalled();
    expect(captured.args).toEqual({ query: 42 });
  });
});
