// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSetChannelConfig,
  mockGetChannelConfig,
  mockChannelManager,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockSetChannelConfig: vi.fn(),
  mockGetChannelConfig: vi.fn(),
  mockChannelManager: { startChannel: vi.fn(), stopChannel: vi.fn() },
  mockAuditLog: vi.fn(),
}));

vi.mock("../../instances/channels.store.js", async () => {
  const actual = await vi.importActual<typeof import("../../instances/channels.store.js")>(
    "../../instances/channels.store.js",
  );
  return {
    ...actual,
    setChannelConfig: mockSetChannelConfig,
    getChannelConfig: mockGetChannelConfig,
    listChannelConfigs: vi.fn().mockResolvedValue([]),
    deleteChannelConfig: vi.fn(),
  };
});

vi.mock("../../channels/channel-manager.js", () => ({ channelManager: mockChannelManager }));
vi.mock("../../instances/agent-tool-sync.js", () => ({ syncAgentTool: vi.fn() }));
vi.mock("./instance-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("./instance-helpers.js")>("./instance-helpers.js");
  return { ...actual, findInstanceOrFail: vi.fn().mockResolvedValue({ id: "uuid-1", slug: "acme", description: null }) };
});
vi.mock("../../management-audit/management-audit-logger.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../management-audit/management-audit-logger.js")
  >("../../management-audit/management-audit-logger.js");
  return { ...actual, createManagementAuditLogger: () => ({ log: mockAuditLog }) };
});

import { InstanceChannelsController } from "./instance-channels.controller.js";

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const API_KEY_SID = "SK00000000000000000000000000000002";
const USER = { id: "u1", email: "admin@example.com" } as never;

describe("InstanceChannelsController — whatsapp credential modes", () => {
  let controller: InstanceChannelsController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InstanceChannelsController();
    mockGetChannelConfig.mockResolvedValue(null);
  });

  it("should_mint_a_webhook_secret_on_the_first_save_in_apiKey_mode", async () => {
    await controller.setChannel("acme", "whatsapp", {
      config: {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        whatsappNumber: "+14155238886",
      },
      enabled: true,
    });

    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should_ignore_a_client_supplied_webhook_secret", async () => {
    await controller.setChannel("acme", "whatsapp", {
      config: {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        whatsappNumber: "+14155238886",
        webhookSecret: "attacker-chosen",
      },
      enabled: true,
    });

    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.webhookSecret).not.toBe("attacker-chosen");
  });

  it("should_drop_the_auth_token_when_switching_to_apiKey", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "old", whatsappNumber: "+14155238886" },
    });

    await controller.setChannel("acme", "whatsapp", {
      config: { authMode: "apiKey", apiKeySid: API_KEY_SID, apiKeySecret: "sec" },
      enabled: true,
    });

    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored).not.toHaveProperty("authToken");
  });

  it("should_reveal_the_webhook_url_for_an_apiKey_channel", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: { authMode: "apiKey", webhookSecret: "abc123", accountSid: ACCOUNT_SID },
    });

    const res = await controller.whatsappWebhookUrl("acme");
    expect(res.webhookUrl).toContain("/webhooks/twilio/acme/whatsapp/abc123");
  });

  it("should_refuse_to_reveal_a_url_for_an_authToken_channel", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok" },
    });

    await expect(controller.whatsappWebhookUrl("acme")).rejects.toThrow();
  });

  it("should_rotate_the_secret_and_audit_the_write", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        webhookSecret: "old-secret",
        whatsappNumber: "+14155238886",
      },
    });

    const res = await controller.rotateWhatsappWebhookSecret("acme", USER);

    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.webhookSecret).not.toBe("old-secret");
    expect(res.webhookUrl).not.toContain("old-secret");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "secret.write", targetType: "secret" }),
    );
  });
});
