// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { AgentChannelAdapter } from "./agent.adapter.js";
import type { IncomingMessage, OutgoingMessage } from "../types.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

describe("AgentChannelAdapter", () => {
  it("dispatches a synthetic IncomingMessage and returns the response text", async () => {
    const adapter = new AgentChannelAdapter();
    const handler = vi.fn(async (msg: IncomingMessage): Promise<OutgoingMessage> => ({
      text: `echo: ${msg.text}`,
      attachments: [],
    }));
    await adapter.initialize(handler);

    const result = await adapter.dispatch({
      targetInstanceId: asInstanceSlug("tgt-uuid"),
      prompt: "hello",
      callerSlug: "acme",
      callerConversationId: "conv-1",
      depth: 1,
    });

    expect(result).toBe("echo: hello");
    expect(handler).toHaveBeenCalledTimes(1);
    const msg = handler.mock.calls[0][0];
    expect(msg.channelType).toBe("agent");
    expect(msg.channelId).toBe("agent:acme");
    expect(msg.instanceId).toBe("tgt-uuid");
    expect(msg.text).toBe("hello");
    expect((msg.metadata as any).agentCall).toEqual({
      callerSlug: "acme",
      callerConversationId: "conv-1",
      parentTraceId: undefined,
      depth: 1,
    });
  });

  it("throws when dispatch is called before initialize", async () => {
    const adapter = new AgentChannelAdapter();
    await expect(
      adapter.dispatch({
        targetInstanceId: asInstanceSlug("x"),
        prompt: "x",
        callerSlug: "x",
        callerConversationId: "x",
        depth: 1,
      })
    ).rejects.toThrow(/not initialized/i);
  });

  it("propagates AbortSignal to the handler", async () => {
    const adapter = new AgentChannelAdapter();
    const handler = vi.fn(async (_msg: IncomingMessage, signal?: AbortSignal) => {
      expect(signal).toBeDefined();
      return { text: "ok", attachments: [] };
    });
    await adapter.initialize(handler);
    const ac = new AbortController();
    await adapter.dispatch({
      targetInstanceId: asInstanceSlug("x"),
      prompt: "x",
      callerSlug: "x",
      callerConversationId: "x",
      depth: 1,
      signal: ac.signal,
    });
    expect(handler).toHaveBeenCalled();
  });

  it("populates metadata.conversationId with a fresh agent:<caller>:<uuid> string", async () => {
    const adapter = new AgentChannelAdapter();
    const handler = vi.fn(async (_msg: IncomingMessage): Promise<OutgoingMessage> => ({ text: "ok", attachments: [] }));
    await adapter.initialize(handler);
    await adapter.dispatch({
      targetInstanceId: asInstanceSlug("x"),
      prompt: "x",
      callerSlug: "acme",
      callerConversationId: "parent",
      depth: 1,
    });
    const msg = handler.mock.calls[0]![0]!;
    expect((msg.metadata as any).conversationId).toMatch(
      /^agent:acme:[0-9a-f-]{36}$/i
    );
  });
});
