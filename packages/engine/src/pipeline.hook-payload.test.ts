// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildHookPayload } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import type { PipelineContext } from "./pipeline.js";

function ctxFor(channel: string): PipelineContext {
  return {
    instanceId: asInstanceSlug("demo"),
    conversationId: "c1",
    isAutoTaskTurn: false,
    channelIdentity: { channel, channelId: "id1", userName: "u" },
  } as unknown as PipelineContext;
}

describe("buildHookPayload synthetic-channel inclusion", () => {
  it("builds a payload for scheduled and agent channels (no longer suppressed)", () => {
    expect(buildHookPayload(ctxFor("scheduled"), "hi")?.channel.type).toBe("scheduled");
    expect(buildHookPayload(ctxFor("agent"), "hi")?.channel.type).toBe("agent");
  });

  it("still suppresses auto-task turns", () => {
    const ctx = { ...ctxFor("whatsapp"), isAutoTaskTurn: true } as unknown as PipelineContext;
    expect(buildHookPayload(ctx, "hi")).toBeUndefined();
  });
});
