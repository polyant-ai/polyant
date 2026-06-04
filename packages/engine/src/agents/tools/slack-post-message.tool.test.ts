// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock channelManager BEFORE importing the tool (which self-registers on import).
vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: {
    sendOutbound: vi.fn(),
  },
}));

import "./slack-post-message.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";
import { channelManager } from "../../channels/channel-manager.js";
import { createMockAudit } from "../../test-utils.js";

const mockSendOutbound = channelManager.sendOutbound as unknown as ReturnType<typeof vi.fn>;

const ctx = {
  instanceId: "my-instance",
  secrets: {},
  audit: createMockAudit(),
} as any;

const toolCtx = { toolCallId: "tc-1", messages: [] } as any;

describe("slackPostMessage", () => {
  const def = getToolRegistry().get("slackPostMessage")!;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is registered with correct metadata", () => {
    expect(def).toBeDefined();
    expect(def.name).toBe("slackPostMessage");
    expect(def.category).toBe("messaging");
  });

  it("has parameters and description", () => {
    const tool = buildTool(def, ctx) as any;
    expect(tool.description).toBeDefined();
    expect(tool.inputSchema).toBeDefined();
  });

  it("posts to a channel by '#name'", async () => {
    const tool = buildTool(def, ctx) as any;
    mockSendOutbound.mockResolvedValueOnce(undefined);

    const result = await tool.execute(
      { channel: "#introductions", message: "🤝 Anna vorrebbe conoscere Marco" },
      toolCtx,
    );

    expect(result.success).toBe(true);
    expect(result.channel).toBe("#introductions");
    expect(mockSendOutbound).toHaveBeenCalledTimes(1);
    expect(mockSendOutbound).toHaveBeenCalledWith(
      "my-instance",
      "slack",
      "#introductions",
      "🤝 Anna vorrebbe conoscere Marco",
    );
  });

  it("posts a DM to a user id ('U...')", async () => {
    const tool = buildTool(def, ctx) as any;
    mockSendOutbound.mockResolvedValueOnce(undefined);

    const result = await tool.execute(
      { channel: "U01ABCDEF", message: "Segnalazione privata" },
      toolCtx,
    );

    expect(result.success).toBe(true);
    expect(mockSendOutbound).toHaveBeenCalledWith("my-instance", "slack", "U01ABCDEF", "Segnalazione privata");
  });

  it("posts to an explicit channel id ('C...')", async () => {
    const tool = buildTool(def, ctx) as any;
    mockSendOutbound.mockResolvedValueOnce(undefined);

    const result = await tool.execute(
      { channel: "C09876XYZ", message: "Alert: backlog > 50" },
      toolCtx,
    );

    expect(result.success).toBe(true);
    expect(mockSendOutbound).toHaveBeenCalledWith("my-instance", "slack", "C09876XYZ", "Alert: backlog > 50");
  });

  it("trims channel and message before sending", async () => {
    const tool = buildTool(def, ctx) as any;
    mockSendOutbound.mockResolvedValueOnce(undefined);

    await tool.execute({ channel: "  #foo  ", message: "  hello  " }, toolCtx);

    expect(mockSendOutbound).toHaveBeenCalledWith("my-instance", "slack", "#foo", "hello");
  });

  it("returns an error when slack channel is not configured for the instance", async () => {
    const tool = buildTool(def, ctx) as any;
    mockSendOutbound.mockRejectedValueOnce(new Error('No active channels for instance "my-instance"'));

    const result = await tool.execute({ channel: "#introductions", message: "hi" }, toolCtx);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("No active channels");
    expect(result.success).toBeUndefined();
  });

  it("propagates adapter errors as { error } without crashing", async () => {
    const tool = buildTool(def, ctx) as any;
    mockSendOutbound.mockRejectedValueOnce(new Error("slack_api_error: channel_not_found"));

    const result = await tool.execute({ channel: "#missing", message: "hi" }, toolCtx);

    expect(result.error).toContain("channel_not_found");
  });

  it("does not log the message body in audit details (only length)", async () => {
    const audit = createMockAudit();
    const auditCtx = { ...ctx, audit } as any;
    const tool = buildTool(def, auditCtx) as any;
    mockSendOutbound.mockResolvedValueOnce(undefined);

    const sensitive = "Mario Rossi, tel +1 555 123 4567, allergia al lattosio";
    await tool.execute({ channel: "#introductions", message: sensitive }, toolCtx);

    const logged = (audit.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("lattosio");
    expect(serialized).not.toContain("555");
    // but length should be present for telemetry
    expect(logged.details.messageLen).toBe(sensitive.length);
  });
});
