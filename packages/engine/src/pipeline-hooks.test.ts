// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildHookPayload, type PipelineContext } from "./pipeline.js";
import { asAgentSlug } from "./instances/identifiers.js";

function ctxWith(overrides: Partial<PipelineContext>): PipelineContext {
  return {
    pipelineStart: 0,
    agentId: asAgentSlug("demo"),
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
    expect(payload?.response).toEqual({ text: "risposta" });
  });

  it("should_return_undefined_for_auto_task_turns", () => {
    expect(buildHookPayload(ctxWith({ isAutoTaskTurn: true }), "### Task: x")).toBeUndefined();
  });

  it("should_return_undefined_without_channel_identity", () => {
    expect(buildHookPayload(ctxWith({ channelIdentity: undefined }), "x")).toBeUndefined();
  });

  it("should_return_undefined_for_synthetic_channels", () => {
    for (const channel of ["agent", "scheduled", "room"]) {
      const ctx = ctxWith({ channelIdentity: { channel, channelId: "x" } });
      expect(buildHookPayload(ctx, "x")).toBeUndefined();
    }
  });

  it("should_default_user_name_to_empty_string", () => {
    const ctx = ctxWith({ channelIdentity: { channel: "telegram", channelId: "42" } });
    expect(buildHookPayload(ctx, "x")?.user).toEqual({ name: "" });
  });
});
