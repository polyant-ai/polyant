// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockWebhookUrl, mockRotate, mockSet } = vi.hoisted(() => ({
  mockWebhookUrl: vi.fn(),
  mockRotate: vi.fn(),
  mockSet: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { channels: { webhookUrl: mockWebhookUrl, rotateWebhookSecret: mockRotate, set: mockSet, delete: vi.fn() } },
  getUserErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WhatsAppChannelCard } from "./whatsapp-channel-card.js";

describe("WhatsAppChannelCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebhookUrl.mockResolvedValue({ webhookUrl: "https://engine.example/webhooks/twilio/acme/whatsapp/abc" });
    mockSet.mockResolvedValue({ channel: null });
    mockRotate.mockResolvedValue({ webhookUrl: "https://engine.example/webhooks/twilio/acme/whatsapp/new" });
  });

  it("should_show_the_auth_token_field_in_authToken_mode", () => {
    render(<WhatsAppChannelCard slug="acme" channel={null} onChanged={vi.fn()} />);

    expect(screen.getByLabelText("channels.tab.whatsappAuthToken")).toBeDefined();
    expect(screen.queryByLabelText("channels.tab.whatsappApiKeySid")).toBeNull();
  });

  it("should_swap_to_the_api_key_fields_when_the_mode_changes", async () => {
    render(<WhatsAppChannelCard slug="acme" channel={null} onChanged={vi.fn()} />);

    await userEvent.selectOptions(
      screen.getByLabelText("channels.tab.whatsappAuthMode"),
      "apiKey",
    );

    expect(screen.getByLabelText("channels.tab.whatsappApiKeySid")).toBeDefined();
    expect(screen.queryByLabelText("channels.tab.whatsappAuthToken")).toBeNull();
    expect(screen.getByText("channels.tab.whatsappModeSwitchWarning")).toBeDefined();
  });

  it("should_show_the_webhook_url_for_a_saved_api_key_channel", async () => {
    render(
      <WhatsAppChannelCard
        slug="acme"
        channel={{ channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } }}
        onChanged={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("https://engine.example/webhooks/twilio/acme/whatsapp/abc")).toBeDefined(),
    );
  });

  it("should_not_fetch_a_webhook_url_for_an_auth_token_channel", () => {
    render(
      <WhatsAppChannelCard
        slug="acme"
        channel={{ channelType: "whatsapp", enabled: true, config: { authMode: "authToken" } }}
        onChanged={vi.fn()}
      />,
    );

    expect(mockWebhookUrl).not.toHaveBeenCalled();
  });
});
