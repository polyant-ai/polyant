// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSendOutbound } = vi.hoisted(() => ({ mockSendOutbound: vi.fn() }));
vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: { sendOutbound: mockSendOutbound },
}));

import whatsappSendMessageTool from "./whatsapp-send-message.tool.js";
import { buildTool } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";

const ctx = {
  instanceId: "test-inst",
  secrets: {},
  audit: createMockAudit(),
} as any;

function buildWhatsappTool() {
  const def = whatsappSendMessageTool;
  expect(def).toBeDefined();
  return buildTool(def, ctx) as any;
}

describe("whatsappSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendOutbound.mockResolvedValue(undefined);
  });

  it("is registered with the messaging category", () => {
    const def = whatsappSendMessageTool;
    expect(def.name).toBe("whatsappSendMessage");
    expect(def.category).toBe("messaging");
  });

  it("rejects an empty recipient", async () => {
    const tool = buildWhatsappTool();
    const result = await tool.execute({ to: "   ", message: "hi", mediaUrl: null });
    expect(result.error).toContain("'to'");
    expect(mockSendOutbound).not.toHaveBeenCalled();
  });

  it("rejects when both message and mediaUrl are empty", async () => {
    const tool = buildWhatsappTool();
    const result = await tool.execute({ to: "+14155550100", message: "  ", mediaUrl: null });
    expect(result.error).toMatch(/at least one/);
    expect(mockSendOutbound).not.toHaveBeenCalled();
  });

  it("rejects a non-https mediaUrl", async () => {
    const tool = buildWhatsappTool();
    const result = await tool.execute({
      to: "+14155550100",
      message: "see attached",
      mediaUrl: "http://insecure.example/file.pdf",
    });
    expect(result.error).toContain("https");
    expect(mockSendOutbound).not.toHaveBeenCalled();
  });

  it("sends text only with undefined opts", async () => {
    const tool = buildWhatsappTool();
    const result = await tool.execute({ to: "+14155550100", message: "Hello there", mediaUrl: null });

    expect(result).toMatchObject({ success: true, to: "+14155550100" });
    expect(mockSendOutbound).toHaveBeenCalledWith("test-inst", "whatsapp", "+14155550100", "Hello there", undefined);
  });

  it("sends text + media, threading mediaUrl through sendOutbound", async () => {
    const tool = buildWhatsappTool();
    const result = await tool.execute({
      to: "+14155550100",
      message: "Here is the quote.",
      mediaUrl: "https://hubspot.example/files/abc.pdf",
    });

    expect(result).toMatchObject({ success: true, mediaUrl: "https://hubspot.example/files/abc.pdf" });
    expect(mockSendOutbound).toHaveBeenCalledWith(
      "test-inst",
      "whatsapp",
      "+14155550100",
      "Here is the quote.",
      { mediaUrl: "https://hubspot.example/files/abc.pdf" },
    );
  });

  it("returns an error result when the channel send throws", async () => {
    mockSendOutbound.mockRejectedValueOnce(new Error("channel not active"));
    const tool = buildWhatsappTool();
    const result = await tool.execute({ to: "+14155550100", message: "hi", mediaUrl: null });
    expect(result.error).toMatch(/WhatsApp send failed/);
  });
});
