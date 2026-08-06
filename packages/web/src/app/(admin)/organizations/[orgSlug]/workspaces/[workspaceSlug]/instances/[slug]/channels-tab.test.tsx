// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for the Channels tab, which had none — which is why three defects in it
 * shipped green:
 *
 *  1. the Agent-to-Agent switch had NO path to persistence. The immediate write
 *     was removed while the Save button was still suppressed for config-less
 *     channels, so the switch flicked, looked saved, and reverted on reload. Since
 *     the `instance_channels` row IS the A2A toggle, agent-to-agent handoffs could
 *     not be enabled or disabled from the panel at all;
 *  2. every channel section lost its title, because the `nameKey` label was
 *     deleted along with it — four identical bordered boxes;
 *  3. the "no Delete for a config-less channel" gate landed on the status Badge
 *     instead of the delete dialog, so A2A lost its badge and kept its trash
 *     button — which, with (1), was the only working way to turn it off.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelsTab } from "./channels-tab";
import type { ChannelConfig } from "@/lib/api";

const { mockList, mockSet, mockDelete } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockSet: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  api: {
    channels: {
      list: (...args: unknown[]) => mockList(...args),
      set: (...args: unknown[]) => mockSet(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

function channel(channelType: string, enabled: boolean): ChannelConfig {
  return {
    channelType,
    enabled,
    config: {},
  } as unknown as ChannelConfig;
}

/** The switch belonging to a section, found via that section's title. */
function switchIn(titleKey: string): HTMLElement {
  const heading = screen.getByText(titleKey);
  const section = heading.closest("section");
  if (!section) throw new Error(`no section for ${titleKey}`);
  const found = section.querySelector('[role="switch"]');
  if (!found) throw new Error(`no switch in ${titleKey}`);
  return found as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({ channels: [] });
  mockSet.mockResolvedValue({ channel: null });
  mockDelete.mockResolvedValue({ deleted: true });
});

describe("ChannelsTab — every section is identifiable", () => {
  it("renders a title for each of the four channels", async () => {
    render(<ChannelsTab slug="a1" />);

    // The rail's "Channels" label names the PAGE; this tab stacks all four
    // channels as sections, so each still needs its own heading.
    await waitFor(() => {
      expect(screen.getByText("channels.tab.telegram")).toBeInTheDocument();
    });
    expect(screen.getByText("channels.tab.slack")).toBeInTheDocument();
    expect(screen.getByText("channels.tab.whatsapp")).toBeInTheDocument();
    expect(screen.getByText("channels.tab.agent")).toBeInTheDocument();
  });
});

describe("ChannelsTab — the Agent-to-Agent switch can be saved", () => {
  it("offers a Save after flicking the config-less channel's switch", async () => {
    render(<ChannelsTab slug="a1" />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    await userEvent.click(switchIn("channels.tab.agent"));

    // Without a Save button this switch has no path to the server at all.
    const save = await screen.findByRole("button", { name: "common.saveSingle" });
    expect(save).toBeInTheDocument();
  });

  it("persists the enabled flag for the config-less channel", async () => {
    render(<ChannelsTab slug="a1" />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    await userEvent.click(switchIn("channels.tab.agent"));
    await userEvent.click(await screen.findByRole("button", { name: "common.saveSingle" }));

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith("a1", "agent", {}, true);
    });
  });

  it("does not write anything until Save is pressed", async () => {
    render(<ChannelsTab slug="a1" />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    await userEvent.click(switchIn("channels.tab.agent"));

    // The switch marks the section dirty; it must not write on its own — that
    // silent write is what the immediate path was removed for.
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("writes nothing on mount", async () => {
    mockList.mockResolvedValue({ channels: [channel("agent", true)] });

    render(<ChannelsTab slug="a1" />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("ChannelsTab — Delete belongs to channels that hold configuration", () => {
  it("shows a status badge for a configured config-less channel", async () => {
    mockList.mockResolvedValue({ channels: [channel("agent", true)] });

    render(<ChannelsTab slug="a1" />);

    await waitFor(() => expect(screen.getByText("channels.tab.enabled")).toBeInTheDocument());
  });

  it("offers no Delete for a configured config-less channel", async () => {
    mockList.mockResolvedValue({ channels: [channel("agent", true)] });

    render(<ChannelsTab slug="a1" />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    // There is no configuration to remove, so Delete would just duplicate the
    // switch — with the destructive styling of a different action.
    const section = screen.getByText("channels.tab.agent").closest("section")!;
    expect(section.querySelector("button.text-destructive")).toBeNull();
  });

  it("still offers Delete for a configured channel that holds credentials", async () => {
    mockList.mockResolvedValue({ channels: [channel("telegram", true)] });

    render(<ChannelsTab slug="a1" />);
    await waitFor(() => expect(screen.getByText("channels.tab.telegram")).toBeInTheDocument());

    const section = screen.getByText("channels.tab.telegram").closest("section")!;
    expect(section.querySelector("button.text-destructive")).not.toBeNull();
  });
});
