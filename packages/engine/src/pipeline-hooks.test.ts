// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildHookPayload,
  hasResponseMutatingHook,
  runResponseGeneratedHooks,
  type PipelineContext,
} from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import { getEnabledHooks } from "./hooks/hooks.store.js";
import { getHookRegistry } from "./hooks/hook-registry.js";
import { runHooks, firstReplaceResponse, firstRegenerate } from "./hooks/hook-runner.js";
import type { HookExecutionSummary, HookFunctionDefinition } from "./hooks/hook-types.js";

vi.mock("./hooks/hooks.store.js", () => ({ getEnabledHooks: vi.fn() }));
vi.mock("./hooks/hook-registry.js", () => ({ getHookRegistry: vi.fn() }));
vi.mock("./hooks/hook-runner.js", () => ({
  runHooks: vi.fn(),
  firstHalt: vi.fn(),
  firstReplaceResponse: vi.fn(),
  firstRegenerate: vi.fn(),
  collectInjectContext: vi.fn(() => []),
  hookProvenance: vi.fn(() => undefined),
}));

function ctxWith(overrides: Partial<PipelineContext>): PipelineContext {
  return {
    pipelineStart: 0,
    instanceId: asInstanceSlug("demo"),
    conversationId: "demo:whatsapp:+39",
    conversationSummary: undefined,
    contextPrompt: undefined,
    channelIdentity: { channel: "whatsapp", channelId: "+39", userName: "Paolo" },
    stateBuffer: undefined,
    history: undefined,
    isFirstTurn: true,
    hasOverflow: false,
    droppedMessages: undefined,
    instanceConfig: {} as PipelineContext["instanceConfig"],
    langsmith: undefined,
    userAttachments: undefined,
    incomingSystemMessages: undefined,
    isAutoTaskTurn: false,
    inboundMetadata: undefined,
    ...overrides,
  };
}

describe("buildHookPayload", () => {
  it("should_build_payload_from_channel_identity", () => {
    const payload = buildHookPayload(ctxWith({}), "ciao");
    expect(payload).toEqual({
      instance: { slug: "demo" },
      conversation: { id: "demo:whatsapp:+39" },
      channel: { type: "whatsapp", id: "+39" },
      user: { name: "Paolo" },
      message: { text: "ciao" },
    });
  });

  it("should_include_response_when_text_given", () => {
    const payload = buildHookPayload(ctxWith({}), "ciao", "risposta");
    expect(payload?.response).toEqual({ text: "risposta", regenerationCount: 0 });
  });

  it("should_propagate_a_non_zero_regenerationCount", () => {
    const payload = buildHookPayload(ctxWith({}), "ciao", "risposta", 2);
    expect(payload?.response).toEqual({ text: "risposta", regenerationCount: 2 });
  });

  it("should_return_undefined_for_auto_task_turns", () => {
    expect(buildHookPayload(ctxWith({ isAutoTaskTurn: true }), "### Task: x")).toBeUndefined();
  });

  it("should_return_undefined_without_channel_identity", () => {
    expect(buildHookPayload(ctxWith({ channelIdentity: undefined }), "x")).toBeUndefined();
  });

  it("should_build_payload_for_synthetic_channels", () => {
    // Synthetic channels are no longer suppressed — halt-and-respond needs hooks
    // to run on scheduled/agent turns too. Only auto-tasks stay excluded.
    for (const channel of ["agent", "scheduled", "room"]) {
      const ctx = ctxWith({ channelIdentity: { channel, channelId: "x" } });
      expect(buildHookPayload(ctx, "x")?.channel.type).toBe(channel);
    }
  });

  it("should_default_user_name_to_empty_string", () => {
    const ctx = ctxWith({ channelIdentity: { channel: "telegram", channelId: "42" } });
    expect(buildHookPayload(ctx, "x")?.user).toEqual({ name: "" });
  });
});

describe("hasResponseMutatingHook", () => {
  const slug = asInstanceSlug("demo");

  // Minimal hook row — only `actionConfig.functionName` is read by the helper.
  const hookRow = (functionName: string) =>
    ({ actionConfig: { functionName } }) as never;

  // Minimal registry — only `mutatesResponse` is read.
  const registryOf = (entries: Record<string, boolean>) => {
    const map = new Map<string, HookFunctionDefinition>();
    for (const [name, mutatesResponse] of Object.entries(entries)) {
      map.set(name, { name, mutatesResponse } as HookFunctionDefinition);
    }
    return map;
  };

  beforeEach(() => {
    vi.mocked(getHookRegistry).mockReturnValue(new Map());
    vi.mocked(getEnabledHooks).mockResolvedValue([]);
  });

  it("should_return_true_when_enabled_hook_declares_mutatesResponse", async () => {
    vi.mocked(getEnabledHooks).mockResolvedValue([hookRow("mutator")]);
    vi.mocked(getHookRegistry).mockReturnValue(registryOf({ mutator: true }));
    expect(await hasResponseMutatingHook(slug)).toBe(true);
  });

  it("should_return_false_when_no_hook_declares_mutatesResponse", async () => {
    vi.mocked(getEnabledHooks).mockResolvedValue([hookRow("observer")]);
    vi.mocked(getHookRegistry).mockReturnValue(registryOf({ observer: false }));
    expect(await hasResponseMutatingHook(slug)).toBe(false);
  });

  it("should_return_false_on_registry_miss", async () => {
    // Hook references a function name absent from the registry (loader/config skew).
    vi.mocked(getEnabledHooks).mockResolvedValue([hookRow("ghost")]);
    vi.mocked(getHookRegistry).mockReturnValue(registryOf({ other: true }));
    expect(await hasResponseMutatingHook(slug)).toBe(false);
  });

  it("should_return_false_when_no_hooks", async () => {
    vi.mocked(getEnabledHooks).mockResolvedValue([]);
    expect(await hasResponseMutatingHook(slug)).toBe(false);
  });

  it("should_return_true_when_any_of_several_hooks_mutates", async () => {
    vi.mocked(getEnabledHooks).mockResolvedValue([hookRow("a"), hookRow("b")]);
    vi.mocked(getHookRegistry).mockReturnValue(registryOf({ a: false, b: true }));
    expect(await hasResponseMutatingHook(slug)).toBe(true);
  });

  it("should_return_false_when_getEnabledHooks_rejects", async () => {
    vi.mocked(getEnabledHooks).mockRejectedValue(new Error("db down"));
    expect(await hasResponseMutatingHook(slug)).toBe(false);
  });
});

describe("runResponseGeneratedHooks", () => {
  beforeEach(() => {
    vi.mocked(runHooks).mockReset();
    vi.mocked(firstReplaceResponse).mockReset();
    vi.mocked(firstRegenerate).mockReset();
  });

  it("builds the payload with the passed regenerationCount and maps replace/regenerate onto the outcome", async () => {
    const summaries: HookExecutionSummary[] = [
      { hookId: "h1", event: "response_generated", actionType: "function", toolName: "t", success: true, durationMs: 1 },
    ];
    vi.mocked(runHooks).mockResolvedValue(summaries);
    vi.mocked(firstReplaceResponse).mockReturnValue({ message: "replaced" });
    vi.mocked(firstRegenerate).mockReturnValue({ reason: "dirty" });

    const outcome = await runResponseGeneratedHooks(ctxWith({}), "hi", "out", 2);

    expect(runHooks).toHaveBeenCalledWith(
      "response_generated",
      expect.objectContaining({ response: { text: "out", regenerationCount: 2 } }),
      expect.anything(),
    );
    expect(outcome).toEqual({
      summaries,
      replace: { message: "replaced" },
      regenerate: { reason: "dirty" },
    });
  });

  it("returns empty summaries and never calls runHooks when hooks must not fire", async () => {
    const outcome = await runResponseGeneratedHooks(
      ctxWith({ channelIdentity: undefined }),
      "hi",
      "out",
      0,
    );
    expect(outcome).toEqual({ summaries: [] });
    expect(runHooks).not.toHaveBeenCalled();
  });
});
