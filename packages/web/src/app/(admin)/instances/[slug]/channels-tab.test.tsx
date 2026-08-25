// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import { ChannelsTab } from "./channels-tab";
import type { ChannelConfig } from "@/lib/api";

// ── Mocks ──────────────────────────────────────────────────────────────

const { mockToastError, mockChannelsList } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockChannelsList: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    channels: {
      list: (...args: unknown[]) => mockChannelsList(...args),
      set: vi.fn().mockResolvedValue({ channel: null }),
      delete: vi.fn().mockResolvedValue({ deleted: true }),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

// The card owns its own form/save/delete UI (tested separately in
// whatsapp-channel-card.test.tsx) — mocking it here keeps this test focused
// on the wiring: is the card rendered in place of the generic field list?
vi.mock("./whatsapp-channel-card", () => ({
  WhatsAppChannelCard: ({ slug, channel }: { slug: string; channel: ChannelConfig | null; onChanged: () => void }) => (
    <div data-testid="whatsapp-channel-card">
      whatsapp-card for {slug} ({channel ? "configured" : "unconfigured"})
    </div>
  ),
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    channelType: "telegram",
    enabled: true,
    config: {},
    ...overrides,
  } as ChannelConfig;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("ChannelsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelsList.mockResolvedValue({ channels: [] });
  });

  it("renders the WhatsApp section through the dedicated card, not the generic field list", async () => {
    mockChannelsList.mockResolvedValue({
      channels: [makeChannel({ channelType: "whatsapp", config: { accountSid: "AC123" } })],
    });

    render(<ChannelsTab slug="test-instance" />);

    await waitFor(() => {
      expect(screen.getByTestId("whatsapp-channel-card")).toBeInTheDocument();
    });
    expect(screen.getByText("whatsapp-card for test-instance (configured)")).toBeInTheDocument();

    // The generic field-list renderer must not also render WhatsApp's fields.
    expect(screen.queryByText("channels.tab.whatsappAccountSid")).not.toBeInTheDocument();
    expect(screen.queryByText("channels.tab.whatsappNumber")).not.toBeInTheDocument();
  });

  it("passes an unconfigured (null) channel to the card when whatsapp has no saved config", async () => {
    mockChannelsList.mockResolvedValue({ channels: [] });

    render(<ChannelsTab slug="test-instance" />);

    await waitFor(() => {
      expect(screen.getByTestId("whatsapp-channel-card")).toBeInTheDocument();
    });
    expect(screen.getByText("whatsapp-card for test-instance (unconfigured)")).toBeInTheDocument();
  });

  it("still renders telegram, slack and agent through the generic field-list loop", async () => {
    mockChannelsList.mockResolvedValue({
      channels: [
        makeChannel({ channelType: "telegram", config: { botToken: "tg-token" } }),
        makeChannel({ channelType: "slack", config: { botToken: "sl-token" } }),
      ],
    });

    render(<ChannelsTab slug="test-instance" />);

    await waitFor(() => {
      expect(screen.getByText("channels.tab.telegram")).toBeInTheDocument();
    });

    expect(screen.getByText("channels.tab.slack")).toBeInTheDocument();
    expect(screen.getByText("channels.tab.agent")).toBeInTheDocument();

    // Generic fields for the non-custom channels are still present.
    expect(screen.getByText("channels.tab.telegramBotToken")).toBeInTheDocument();
    expect(screen.getByText("channels.tab.slackBotToken")).toBeInTheDocument();
    expect(screen.getByText("channels.tab.slackAppToken")).toBeInTheDocument();
    expect(screen.getByText("channels.tab.slackSigningSecret")).toBeInTheDocument();
  });

  it("keeps whatsapp in its original position between slack and agent", async () => {
    mockChannelsList.mockResolvedValue({ channels: [] });

    render(<ChannelsTab slug="test-instance" />);

    await waitFor(() => {
      expect(screen.getByTestId("whatsapp-channel-card")).toBeInTheDocument();
    });

    const container = screen.getByText("channels.tab.description").parentElement;
    expect(container).not.toBeNull();
    const text = container?.textContent ?? "";
    const slackIdx = text.indexOf("channels.tab.slack");
    const whatsappIdx = text.indexOf("whatsapp-card for");
    const agentIdx = text.indexOf("channels.tab.agent");
    expect(slackIdx).toBeGreaterThan(-1);
    expect(whatsappIdx).toBeGreaterThan(slackIdx);
    expect(agentIdx).toBeGreaterThan(whatsappIdx);
  });

  it("surfaces a toast error when the initial channel list fails to load", async () => {
    mockChannelsList.mockRejectedValue(new Error("network error"));

    render(<ChannelsTab slug="test-instance" />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("channels.tab.saveFailed");
    });
  });
});
