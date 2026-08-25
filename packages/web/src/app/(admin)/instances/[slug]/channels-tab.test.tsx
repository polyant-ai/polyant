// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
// on the wiring: is the card rendered in place of the generic field list,
// and does the `onChanged` callback passed into it actually refresh the tab?
// `onChanged` is exposed as a clickable button so tests can trigger it the
// same way the real card would (e.g. after a successful save or delete).
vi.mock("./whatsapp-channel-card", () => ({
  WhatsAppChannelCard: ({
    slug,
    channel,
    onChanged,
  }: {
    slug: string;
    channel: ChannelConfig | null;
    onChanged: () => void;
  }) => (
    <div data-testid="whatsapp-channel-card">
      whatsapp-card for {slug} ({channel ? "configured" : "unconfigured"})
      <button type="button" data-testid="whatsapp-card-changed" onClick={onChanged}>
        trigger onChanged
      </button>
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

    // The generic renderer's own section title only appears when the
    // `custom` early return in channels-tab is skipped and WhatsApp falls
    // through to the field-list branch — with the early return in place,
    // that title text never appears since the mocked card doesn't render it.
    expect(screen.queryByText("channels.tab.whatsapp")).not.toBeInTheDocument();
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

  it("re-fetches the channel list and refreshes displayed state when the card reports onChanged", async () => {
    // First load: WhatsApp is configured. After `onChanged` fires (e.g. the
    // card just deleted the channel), the list endpoint reports it gone.
    // This must be reflected in the DOM: `isConfigured` (and hence what the
    // card is told via its `channel` prop) is derived from the `channels`
    // state array, not from `channelStates` — so a refactor that keeps
    // `initStates(res.channels)` but drops `setChannels(res.channels)` in
    // the inline `onChanged` would leave this test's second assertion
    // failing (the card would still be told it's "configured").
    mockChannelsList
      .mockResolvedValueOnce({
        channels: [makeChannel({ channelType: "whatsapp", enabled: true, config: { accountSid: "AC123" } })],
      })
      .mockResolvedValueOnce({ channels: [] });

    const user = userEvent.setup();
    render(<ChannelsTab slug="test-instance" />);

    await waitFor(() => {
      expect(screen.getByText("whatsapp-card for test-instance (configured)")).toBeInTheDocument();
    });
    expect(mockChannelsList).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("whatsapp-card-changed"));

    await waitFor(() => {
      expect(mockChannelsList).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText("whatsapp-card for test-instance (unconfigured)")).toBeInTheDocument();
    });
  });
});
