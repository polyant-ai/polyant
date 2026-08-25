// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";

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

/** Minimal valid apiKey-mode WhatsApp config body, as sent by an admin client. */
function apiKeyBody(extra: Record<string, unknown> = {}) {
  return {
    config: {
      authMode: "apiKey",
      accountSid: ACCOUNT_SID,
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      whatsappNumber: "+14155238886",
      ...extra,
    },
    enabled: true,
  };
}

describe("InstanceChannelsController — whatsapp credential modes", () => {
  let controller: InstanceChannelsController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InstanceChannelsController();
    mockGetChannelConfig.mockResolvedValue(null);
    // Default: the store did not mint a new secret. Individual tests override
    // this to exercise the audit-on-mint path.
    mockSetChannelConfig.mockResolvedValue({ mintedWebhookSecret: false });
  });

  // -------------------------------------------------------------------
  // Allowlist merge — the config sent to the (mocked) store must never
  // contain a property the client wrote that isn't in CHANNEL_CONFIG_KEYS.
  // -------------------------------------------------------------------
  describe("request-body allowlist", () => {
    it("should_ignore_a_client_supplied_webhook_secret", async () => {
      await controller.setChannel("acme", "whatsapp", apiKeyBody({ webhookSecret: "attacker-chosen" }));

      const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
      // `webhookSecret` is absent from CHANNEL_CONFIG_KEYS.whatsapp, so the
      // allowlist merge must drop it outright — not merely "not equal to the
      // attacker's value" (which `undefined` would vacuously satisfy).
      expect(stored).not.toHaveProperty("webhookSecret");
    });

    it("should_drop_a_non_allowlisted_property_written_by_the_client", async () => {
      await controller.setChannel("acme", "whatsapp", apiKeyBody({ evilKey: 1 }));

      const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
      expect(stored).not.toHaveProperty("evilKey");
    });

    it("should_drop_a___proto___payload_without_it_reaching_the_stored_config", async () => {
      // JSON.parse (unlike an object literal) creates a normal OWN enumerable
      // "__proto__" property, which is exactly the shape a real request body
      // arrives in after the framework's body parser runs.
      const body = JSON.parse(
        JSON.stringify({ config: { ...apiKeyBody().config, __proto__: { polluted: true } }, enabled: true }),
      );

      await controller.setChannel("acme", "whatsapp", body);

      const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
      expect((stored as { polluted?: unknown }).polluted).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // Audit — setChannel must audit exactly when the store reports it minted
  // a fresh secret, with the same shape as the explicit rotation endpoint.
  // -------------------------------------------------------------------
  describe("audit on mint", () => {
    it("should_audit_a_secret_write_when_the_store_mints_a_webhook_secret", async () => {
      mockSetChannelConfig.mockResolvedValue({ mintedWebhookSecret: true });
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { ...apiKeyBody().config, webhookSecret: "minted-secret-value" },
      });

      await controller.setChannel("acme", "whatsapp", apiKeyBody(), USER);

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "secret.write",
          targetType: "secret",
          targetId: "acme:whatsapp.webhookSecret",
        }),
      );
      // The audited row must carry the KEY only — never the secret value.
      const auditedArg = mockAuditLog.mock.calls[0][0];
      expect(JSON.stringify(auditedArg)).not.toContain("minted-secret-value");
    });

    it("should_not_audit_when_the_store_did_not_mint_a_secret", async () => {
      mockSetChannelConfig.mockResolvedValue({ mintedWebhookSecret: false });

      await controller.setChannel("acme", "whatsapp", apiKeyBody(), USER);

      expect(mockAuditLog).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Response shape — the PUT response must surface the full webhook URL
  // whenever the saved channel ends up in apiKey mode, so a mode round-trip
  // that silently re-mints the secret is never invisible to the operator.
  // -------------------------------------------------------------------
  describe("PUT response shape", () => {
    it("should_include_the_webhook_url_when_the_saved_channel_is_in_apiKey_mode", async () => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { ...apiKeyBody().config, webhookSecret: "abc123" },
      });

      const res = await controller.setChannel("acme", "whatsapp", apiKeyBody());

      expect(res.webhookUrl).toContain("/webhooks/twilio/acme/whatsapp/abc123");
    });

    it("should_omit_the_webhook_url_when_the_saved_channel_is_in_authToken_mode", async () => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: "+14155238886" },
      });

      const res = await controller.setChannel("acme", "whatsapp", {
        config: { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: "+14155238886" },
        enabled: true,
      });

      expect(res).not.toHaveProperty("webhookUrl");
    });
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

    await expect(controller.whatsappWebhookUrl("acme")).rejects.toThrow(NotFoundException);
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
      expect.objectContaining({
        action: "secret.write",
        targetType: "secret",
        targetId: "acme:whatsapp.webhookSecret",
      }),
    );
    // The audited row must carry the KEY only — never the secret value.
    const auditedArg = mockAuditLog.mock.calls[0][0];
    expect(JSON.stringify(auditedArg)).not.toContain("old-secret");
    expect(JSON.stringify(auditedArg)).not.toContain(stored.webhookSecret as string);
  });
});
