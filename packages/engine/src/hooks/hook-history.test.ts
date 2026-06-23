// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { hookExecutionsToModelMessages, hookExecutionsToSteps } from "./hook-history.js";
import type { HookExecutionSummary } from "./hook-types.js";

function exec(over: Partial<HookExecutionSummary>): HookExecutionSummary {
  return {
    hookId: "h1",
    event: "conversation_start",
    actionType: "tool",
    toolName: "lookupContact",
    success: true,
    durationMs: 12,
    args: { contactId: null },
    result: '{"status":"ambiguous","candidates":[{"fullName":"Mario Rossi"}]}',
    ...over,
  };
}

describe("hookExecutionsToModelMessages", () => {
  it("maps a successful tool execution to an assistant tool-call + tool tool-result pair", () => {
    const msgs = hookExecutionsToModelMessages([exec({})]);
    expect(msgs).toHaveLength(2);

    const assistant = msgs[0] as unknown as { role: string; content: Array<Record<string, unknown>> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content[0]).toMatchObject({ type: "tool-call", toolCallId: "hook:h1", toolName: "lookupContact", input: { contactId: null } });

    const tool = msgs[1] as unknown as { role: string; content: Array<Record<string, unknown>> };
    expect(tool.role).toBe("tool");
    expect(tool.content[0]).toMatchObject({ type: "tool-result", toolCallId: "hook:h1", toolName: "lookupContact" });
    expect((tool.content[0].output as { value: string }).value).toContain("Mario Rossi");
  });

  it("ignores failed, non-tool, and arg-less executions", () => {
    expect(hookExecutionsToModelMessages([exec({ success: false })])).toEqual([]);
    expect(hookExecutionsToModelMessages([exec({ args: undefined })])).toEqual([]);
    expect(hookExecutionsToModelMessages([exec({ actionType: "tool" as const, args: undefined })])).toEqual([]);
    expect(hookExecutionsToModelMessages([])).toEqual([]);
  });

  it("pairs multiple executions, one tool-call/result each, by stable id", () => {
    const msgs = hookExecutionsToModelMessages([exec({ hookId: "a" }), exec({ hookId: "b", toolName: "ccHours" })]);
    const assistant = msgs[0] as unknown as { content: Array<{ toolCallId: string }> };
    const tool = msgs[1] as unknown as { content: Array<{ toolCallId: string }> };
    expect(assistant.content.map((p) => p.toolCallId)).toEqual(["hook:a", "hook:b"]);
    expect(tool.content.map((p) => p.toolCallId)).toEqual(["hook:a", "hook:b"]);
  });
});

describe("hookExecutionsToSteps", () => {
  it("maps a successful tool execution to a StepDetail with paired call + result", () => {
    const steps = hookExecutionsToSteps([exec({ durationMs: 40 })]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      index: 0,
      stepType: "tool-result",
      text: "",
      finishReason: "tool-calls",
      durationMs: 40,
    });
    expect(steps[0].toolCalls).toEqual([{ toolCallId: "hook:h1", toolName: "lookupContact", args: { contactId: null } }]);
    expect(steps[0].toolResults).toEqual([{ toolCallId: "hook:h1", result: exec({}).result }]);
  });

  it("ignores failed executions", () => {
    expect(hookExecutionsToSteps([exec({ success: false })])).toEqual([]);
  });

  it("synthesizes a placeholder result when none was captured but the tool succeeded", () => {
    const steps = hookExecutionsToSteps([exec({ result: undefined })]);
    expect(steps[0].toolResults?.[0].result).toBe("(no result recorded)");
  });
});
