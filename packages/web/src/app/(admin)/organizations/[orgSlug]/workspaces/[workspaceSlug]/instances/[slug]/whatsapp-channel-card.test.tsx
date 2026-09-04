// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const { mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("sonner", () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));

import { WhatsAppChannelCard } from "./whatsapp-channel-card";

/** Opens the (Radix) auth-mode select and picks the given option. */
async function selectAuthMode(user: ReturnType<typeof userEvent.setup>, optionName: string) {
  await user.click(screen.getByRole("combobox", { name: "channels.tab.whatsappAuthMode" }));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

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
    const user = userEvent.setup();
    render(<WhatsAppChannelCard slug="acme" channel={null} onChanged={vi.fn()} />);

    await selectAuthMode(user, "channels.tab.whatsappAuthModeApiKey");

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

  it("should_not_refetch_the_webhook_url_when_an_equivalent_but_new_channel_object_is_passed", async () => {
    const channel1 = { channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } };
    const { rerender } = render(<WhatsAppChannelCard slug="acme" channel={channel1} onChanged={vi.fn()} />);

    await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledTimes(1));

    // A new object, same content — mirrors the parent rebuilding `channel`
    // after every list re-fetch (e.g. after any save/delete elsewhere).
    const channel2 = { channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } };
    rerender(<WhatsAppChannelCard slug="acme" channel={channel2} onChanged={vi.fn()} />);

    // Give any (undesired) effect a chance to fire before asserting it didn't.
    await waitFor(() => expect(screen.getByText(/webhooks\/twilio\/acme\/whatsapp\/abc/)).toBeDefined());
    expect(mockWebhookUrl).toHaveBeenCalledTimes(1);
  });

  describe("save()", () => {
    it("uses the webhookUrl from the PUT response and skips the GET fallback in apiKey mode", async () => {
      const user = userEvent.setup();
      mockSet.mockResolvedValueOnce({
        channel: { channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } },
        webhookUrl: "https://engine.example/webhooks/twilio/acme/whatsapp/from-put",
      });
      render(<WhatsAppChannelCard slug="acme" channel={null} onChanged={vi.fn()} />);

      await selectAuthMode(user, "channels.tab.whatsappAuthModeApiKey");
      await user.type(screen.getByLabelText("channels.tab.whatsappApiKeySid"), "sid");
      await user.type(screen.getByLabelText("channels.tab.whatsappApiKeySecret"), "secret");
      await user.click(screen.getByText("common.saveSingle"));

      await waitFor(() =>
        expect(screen.getByText("https://engine.example/webhooks/twilio/acme/whatsapp/from-put")).toBeDefined(),
      );
      expect(mockWebhookUrl).not.toHaveBeenCalled();
    });

    it("falls back to the GET webhook-url endpoint when the PUT response carries none, in apiKey mode", async () => {
      // Starting from an already-saved apiKey channel (not a fresh one) so
      // `storedMode` is already "apiKey" going into save() — matching the
      // realistic case where re-saving an existing apiKey channel gets back
      // a PUT response with no `webhookUrl`.
      const user = userEvent.setup();
      mockSet.mockResolvedValueOnce({
        channel: { channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } },
      });
      render(
        <WhatsAppChannelCard
          slug="acme"
          channel={{ channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } }}
          onChanged={vi.fn()}
        />,
      );
      await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledTimes(1));

      await user.type(screen.getByLabelText("channels.tab.whatsappApiKeySecret"), "new-secret");
      await user.click(screen.getByText("common.saveSingle"));

      await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.getByText("https://engine.example/webhooks/twilio/acme/whatsapp/abc")).toBeDefined(),
      );
    });

    it("shows no URL and never calls the GET fallback when saving in authToken mode", async () => {
      const user = userEvent.setup();
      mockSet.mockResolvedValueOnce({
        channel: { channelType: "whatsapp", enabled: true, config: { authMode: "authToken" } },
      });
      render(<WhatsAppChannelCard slug="acme" channel={null} onChanged={vi.fn()} />);

      await user.type(screen.getByLabelText("channels.tab.whatsappAuthToken"), "token");
      await user.click(screen.getByText("common.saveSingle"));

      await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
      expect(mockWebhookUrl).not.toHaveBeenCalled();
      expect(screen.queryByText(/^https:\/\//)).toBeNull();
    });
  });

  describe("copy webhook URL", () => {
    const originalClipboard = navigator.clipboard;

    afterEach(() => {
      Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
    });

    it("shows an error toast when navigator.clipboard is unavailable (insecure context)", async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      render(
        <WhatsAppChannelCard
          slug="acme"
          channel={{ channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } }}
          onChanged={vi.fn()}
        />,
      );
      await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalled());

      const copyButtons = screen.getAllByRole("button");
      const copyButton = copyButtons.find((b) => b.querySelector("svg.lucide-copy"));
      await user.click(copyButton!);

      expect(mockToastError).toHaveBeenCalledWith("channels.tab.whatsappUrlCopyFailed");
      expect(mockToastSuccess).not.toHaveBeenCalled();
    });

    it("shows an error toast when writeText() rejects", async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
        configurable: true,
      });
      render(
        <WhatsAppChannelCard
          slug="acme"
          channel={{ channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } }}
          onChanged={vi.fn()}
        />,
      );
      await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalled());

      const copyButtons = screen.getAllByRole("button");
      // The copy button is the icon-only button next to the webhook code block.
      const copyButton = copyButtons.find((b) => b.querySelector("svg.lucide-copy"));
      await user.click(copyButton!);

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("channels.tab.whatsappUrlCopyFailed"));
    });

    it("shows a success toast when the copy succeeds", async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      render(
        <WhatsAppChannelCard
          slug="acme"
          channel={{ channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } }}
          onChanged={vi.fn()}
        />,
      );
      await waitFor(() => expect(mockWebhookUrl).toHaveBeenCalled());

      const copyButtons = screen.getAllByRole("button");
      const copyButton = copyButtons.find((b) => b.querySelector("svg.lucide-copy"));
      await user.click(copyButton!);

      expect(writeText).toHaveBeenCalledWith("https://engine.example/webhooks/twilio/acme/whatsapp/abc");
      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("channels.tab.whatsappUrlCopied"));
    });
  });
});
