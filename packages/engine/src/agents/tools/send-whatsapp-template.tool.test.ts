// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendOutboundTemplate = vi.hoisted(() => vi.fn());
const mockGetTriggerContext = vi.hoisted(() => vi.fn());
const mockRenderStubTemplate = vi.hoisted(() => vi.fn());

vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: {
    sendOutboundTemplate: mockSendOutboundTemplate,
  },
}));
vi.mock("../../webhooks/trigger-context.js", () => ({
  getTriggerContext: mockGetTriggerContext,
}));
vi.mock("../../channels/adapters/whatsapp/stub-templates.js", () => ({
  renderStubTemplate: mockRenderStubTemplate,
}));

import { createMockAudit } from "../../test-utils.js";
import def from "./send-whatsapp-template.tool.js";

function buildExecute(conversationId: string | undefined = "conv-1") {
  const ctx = {
    instanceId: "inst-1",
    secrets: {},
    audit: createMockAudit(),
    conversationId,
  } as any;
  // execute now takes (input, ctx); bind the ctx so call sites pass input only.
  return (input: any) => def.execute(input, ctx);
}

describe("send_whatsapp_template tool (Twilio Content API mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no local stub match → summary fallback path
    mockRenderStubTemplate.mockReturnValue(null);
  });

  it("registers as a harness tool with category 'whatsapp'", () => {
    expect(def.name).toBe("send_whatsapp_template");
    expect(def.harness).toBe(true);
    expect(def.category).toBe("whatsapp");
  });

  it("returns error when trigger context is missing", async () => {
    mockGetTriggerContext.mockReturnValueOnce(null);
    const execute = buildExecute();
    const res = (await execute({ contentSid: "HXabc123", variables: [] })) as { error: string };
    expect(res.error).toMatch(/No active trigger context/i);
    expect(mockSendOutboundTemplate).not.toHaveBeenCalled();
  });

  it("returns error when outbound channel is not whatsapp", async () => {
    mockGetTriggerContext.mockReturnValueOnce({
      instanceSlug: "inst-1",
      outboundChannel: "telegram",
      outboundTarget: "12345",
    });
    const execute = buildExecute();
    const res = (await execute({ contentSid: "HXabc123", variables: [] })) as { error: string };
    expect(res.error).toMatch(/not whatsapp/i);
    expect(mockSendOutboundTemplate).not.toHaveBeenCalled();
  });

  it("sends via channelManager.sendOutboundTemplate with positional→map conversion", async () => {
    mockGetTriggerContext.mockReturnValueOnce({
      instanceSlug: "inst-1",
      outboundChannel: "whatsapp",
      outboundTarget: "+393331234567",
    });
    mockSendOutboundTemplate.mockResolvedValueOnce("SM_TWILIO_123");

    const execute = buildExecute("conv-xyz");
    const res = (await execute({
      contentSid: "HXabc123",
      variables: ["Mario", "May 26"],
    })) as {
      success: boolean;
      replyHandled: boolean;
      replyText: string;
      target: string;
      contentSid: string;
      messageSid: string;
    };

    expect(mockSendOutboundTemplate).toHaveBeenCalledWith(
      "inst-1",
      "whatsapp",
      "+393331234567",
      "HXabc123",
      { "1": "Mario", "2": "May 26" },
    );
    expect(res.success).toBe(true);
    expect(res.replyHandled).toBe(true);
    expect(res.target).toBe("+393331234567");
    expect(res.contentSid).toBe("HXabc123");
    expect(res.messageSid).toBe("SM_TWILIO_123");
  });

  it("persists a summary replyText when stub catalog has no match", async () => {
    mockGetTriggerContext.mockReturnValueOnce({
      instanceSlug: "inst-1",
      outboundChannel: "whatsapp",
      outboundTarget: "+393331234567",
    });
    mockSendOutboundTemplate.mockResolvedValueOnce("SM1");
    mockRenderStubTemplate.mockReturnValueOnce(null);

    const execute = buildExecute();
    const res = (await execute({
      contentSid: "HXabc123",
      variables: ["Mario", "Emanuele"],
    })) as { replyText: string };

    expect(res.replyText).toContain("HXabc123");
    expect(res.replyText).toContain('["Mario","Emanuele"]');
  });

  it("persists the rendered body as replyText when stub catalog has a match", async () => {
    mockGetTriggerContext.mockReturnValueOnce({
      instanceSlug: "inst-1",
      outboundChannel: "whatsapp",
      outboundTarget: "+393331234567",
    });
    mockSendOutboundTemplate.mockResolvedValueOnce("SM1");
    mockRenderStubTemplate.mockReturnValueOnce("Hi Mario, confirmed for May 26.");

    const execute = buildExecute();
    const res = (await execute({
      contentSid: "HXabc123",
      variables: ["Mario", "May 26"],
    })) as { replyText: string };

    expect(mockRenderStubTemplate).toHaveBeenCalledWith("HXabc123", { "1": "Mario", "2": "May 26" });
    expect(res.replyText).toBe("Hi Mario, confirmed for May 26.");
  });

  it("returns error (no replyHandled) when Twilio call fails", async () => {
    mockGetTriggerContext.mockReturnValueOnce({
      instanceSlug: "inst-1",
      outboundChannel: "whatsapp",
      outboundTarget: "+393331234567",
    });
    mockSendOutboundTemplate.mockRejectedValueOnce(new Error("twilio auth failed"));

    const execute = buildExecute();
    const res = (await execute({ contentSid: "HXabc123", variables: ["Mario"] })) as {
      error?: string;
      replyHandled?: boolean;
    };
    expect(res.error).toMatch(/twilio auth failed/);
    expect(res.replyHandled).toBeUndefined();
  });

  it("accepts an explicit empty variables array (templates without placeholders)", async () => {
    // NOTE: variables is required (no .default([])) — OpenAI strict-mode requires
    // every property to appear in `required`. Callers must pass [] explicitly.
    mockGetTriggerContext.mockReturnValueOnce({
      instanceSlug: "inst-1",
      outboundChannel: "whatsapp",
      outboundTarget: "+15555550100",
    });
    mockSendOutboundTemplate.mockResolvedValueOnce("SM1");

    const execute = buildExecute();
    await execute({ contentSid: "HXabc123", variables: [] });

    expect(mockSendOutboundTemplate).toHaveBeenCalledWith(
      "inst-1",
      "whatsapp",
      "+15555550100",
      "HXabc123",
      {},
    );
  });

  it("carries the strict HX contentSid pattern in the serialized JSON Schema", () => {
    // The serialized def exposes JSON Schema (not a live Zod instance), so the
    // regex is preserved as a `pattern` on the contentSid property and shipped
    // to the model — there is no runtime safeParse to assert against anymore.
    const props = def.inputSchema.properties as Record<string, { pattern?: string }>;
    expect(props.contentSid.pattern).toBe("^HX[A-Za-z0-9]+$");
    const required = def.inputSchema.required as string[];
    expect(required).toContain("contentSid");
    expect(required).toContain("variables");
  });
});
