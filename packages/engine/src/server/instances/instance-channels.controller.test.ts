// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { ZodError } from "zod";

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
    // Default: the store did not mint a new secret, and persisted an empty
    // config. Individual tests override this to exercise the audit-on-mint
    // path and to make the persisted config (now read from the store's
    // return value, not a re-fetch) realistic for their assertions.
    mockSetChannelConfig.mockResolvedValue({ mintedWebhookSecret: false, config: {} });
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
      mockSetChannelConfig.mockResolvedValue({
        mintedWebhookSecret: true,
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
      mockSetChannelConfig.mockResolvedValue({ mintedWebhookSecret: false, config: apiKeyBody().config });

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
      // The response is now built from what the store actually returned
      // (item 1), not from a post-save re-fetch — so it is `setChannelConfig`'s
      // resolved value that must carry the secret here.
      mockSetChannelConfig.mockResolvedValue({
        mintedWebhookSecret: false,
        config: { ...apiKeyBody().config, webhookSecret: "abc123" },
      });

      const res = await controller.setChannel("acme", "whatsapp", apiKeyBody());

      expect(res.webhookUrl).toContain("/webhooks/twilio/acme/whatsapp/abc123");
    });

    it("should_omit_the_webhook_url_when_the_saved_channel_is_in_authToken_mode", async () => {
      const authTokenConfig = {
        authMode: "authToken",
        accountSid: ACCOUNT_SID,
        authToken: "tok",
        whatsappNumber: "+14155238886",
      };
      mockSetChannelConfig.mockResolvedValue({ mintedWebhookSecret: false, config: authTokenConfig });

      const res = await controller.setChannel("acme", "whatsapp", { config: authTokenConfig, enabled: true });

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

    // The new secret travels ONLY via `rotateWebhookSecretTo` (item 1) — the
    // `config` argument itself must carry no webhookSecret at all, old or new.
    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored).not.toHaveProperty("webhookSecret");
    const options = mockSetChannelConfig.mock.calls[0][4] as { rotateWebhookSecretTo?: string };
    const newSecret = options.rotateWebhookSecretTo;
    expect(newSecret).toBeTruthy();
    expect(newSecret).not.toBe("old-secret");
    expect(res.webhookUrl).toContain(newSecret as string);
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
    expect(JSON.stringify(auditedArg)).not.toContain(newSecret as string);
  });

  // -------------------------------------------------------------------
  // Item 3 — controller-level proof of the carry-forward invariant. The
  // store-level test (channels.store.test.ts) proves the store preserves a
  // secret it is HANDED; this proves the controller actually HANDS it the
  // existing config, via `mergeAllowedConfig`'s `{ ...existing }` base.
  // Mutating that to `{}` must fail this test (verified manually — see the
  // task report).
  // -------------------------------------------------------------------
  describe("carry-forward through the allowlist merge", () => {
    it("should_carry_the_untouched_apiKeySecret_forward_and_apply_only_the_new_number", async () => {
      const EXISTING_CONFIG = {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "real",
        webhookSecret: "carried",
        whatsappNumber: "+14155238886",
      };
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: EXISTING_CONFIG,
      });
      // Stand-in for the store's own carry-forward logic (unit-tested
      // separately in channels.store.test.ts): a save that supplies no
      // webhookSecret and only changes whatsappNumber keeps the existing
      // secret and mints nothing.
      mockSetChannelConfig.mockResolvedValue({
        mintedWebhookSecret: false,
        config: { ...EXISTING_CONFIG, whatsappNumber: "+19995551234" },
      });

      await controller.setChannel("acme", "whatsapp", {
        config: { whatsappNumber: "+19995551234", apiKeySecret: "••••real" },
        enabled: true,
      });

      // The client sent the masked placeholder for apiKeySecret (never the
      // real value) and no webhookSecret at all — the ONLY way `stored` can
      // carry the real `apiKeySecret` and the ORIGINAL `webhookSecret` is if
      // the merge started from `{ ...existing }`, not `{}`.
      const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
      expect(stored.apiKeySecret).toBe("real");
      expect(stored.webhookSecret).toBe("carried");
      expect(stored.whatsappNumber).toBe("+19995551234");

      // The persisted result (item 1: taken from the store's return value)
      // still carries the ORIGINAL secret, and no mint was reported.
      expect(mockAuditLog).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Item 4 — the guard translating a store failure into a 400 must react
  // ONLY to a real ZodError, not any error whose message happens to contain
  // a particular substring.
  // -------------------------------------------------------------------
  describe("validation error translation", () => {
    it("should_translate_a_ZodError_from_the_store_into_a_BadRequestException", async () => {
      mockSetChannelConfig.mockRejectedValue(new ZodError([]));

      await expect(controller.setChannel("acme", "whatsapp", apiKeyBody())).rejects.toThrow(BadRequestException);
    });

    it("should_NOT_translate_a_non_ZodError_even_if_its_message_contains_Validation", async () => {
      mockSetChannelConfig.mockRejectedValue(new Error("Validation exploded for unrelated reasons"));

      await expect(controller.setChannel("acme", "whatsapp", apiKeyBody())).rejects.not.toThrow(
        BadRequestException,
      );
    });
  });
});
