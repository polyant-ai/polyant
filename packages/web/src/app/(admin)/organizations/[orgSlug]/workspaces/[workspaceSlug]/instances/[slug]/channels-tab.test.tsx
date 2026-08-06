// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for the Channels tab, which had none — which is why three defects in it
 * shipped green:
 *
 *  1. the Agent-to-Agent switch had NO path to persistence. The immediate write
 *     was removed while the Save button was still suppressed for config-less
 *     channels, so the switch flicked, looked saved, and reverted on reload. Since
 *     the `instance_channels` row IS what enables in-process handoffs, they could
 *     not be turned on or off from the panel at all. (Careful reading this: the
 *     `agent` CHANNEL is the internal, in-deployment path. The A2A PROTOCOL —
 *     external, over HTTP — is `instances.a2a_enabled`, a different switch in the
 *     same section, added later.);
 *  2. every channel section lost its title, because the `nameKey` label was
 *     deleted along with it — four identical bordered boxes;
 *  3. the "no Delete for a config-less channel" gate landed on the status Badge
 *     instead of the delete dialog, so the section lost its badge and kept its
 *     trash button — which, with (1), was the only working way to turn it off.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelsTab } from "./channels-tab";
import type { ChannelConfig } from "@/lib/api";

const { mockList, mockSet, mockDelete, mockInstanceUpdate } = vi.hoisted(() => ({
  mockInstanceUpdate: vi.fn(),
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
    // A2A is not a channel: it persists through the instance endpoint.
    instances: { update: (...args: unknown[]) => mockInstanceUpdate(...args) },
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

/** Only `a2aEnabled` is read by this component; the cast keeps the fixture honest
 *  about that instead of stubbing forty unrelated instance fields. */
const INSTANCE = { a2aEnabled: false } as never;

describe("ChannelsTab — every section is identifiable", () => {
  it("renders a title for each of the four channels", async () => {
    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);

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
    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    await userEvent.click(switchIn("channels.tab.agent"));

    // Without a Save button this switch has no path to the server at all.
    const save = await screen.findByRole("button", { name: "common.saveSingle" });
    expect(save).toBeInTheDocument();
  });

  it("persists the enabled flag for the config-less channel", async () => {
    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    await userEvent.click(switchIn("channels.tab.agent"));
    await userEvent.click(await screen.findByRole("button", { name: "common.saveSingle" }));

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith("a1", "agent", {}, true);
    });
  });

  it("does not write anything until Save is pressed", async () => {
    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    await userEvent.click(switchIn("channels.tab.agent"));

    // The switch marks the section dirty; it must not write on its own — that
    // silent write is what the immediate path was removed for.
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("writes nothing on mount", async () => {
    mockList.mockResolvedValue({ channels: [channel("agent", true)] });

    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("ChannelsTab — Delete belongs to channels that hold configuration", () => {
  it("shows a status badge for a configured config-less channel", async () => {
    mockList.mockResolvedValue({ channels: [channel("agent", true)] });

    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);

    await waitFor(() => expect(screen.getByText("channels.tab.enabled")).toBeInTheDocument());
  });

  it("offers no Delete for a configured config-less channel", async () => {
    mockList.mockResolvedValue({ channels: [channel("agent", true)] });

    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    // There is no configuration to remove, so Delete would just duplicate the
    // switch — with the destructive styling of a different action.
    const section = screen.getByText("channels.tab.agent").closest("section")!;
    expect(section.querySelector("button.text-destructive")).toBeNull();
  });

  it("still offers Delete for a configured channel that holds credentials", async () => {
    mockList.mockResolvedValue({ channels: [channel("telegram", true)] });

    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText("channels.tab.telegram")).toBeInTheDocument());

    const section = screen.getByText("channels.tab.telegram").closest("section")!;
    expect(section.querySelector("button.text-destructive")).not.toBeNull();
  });
});

/**
 * A2A sits under Agent-to-Agent because both answer "who else may drive this
 * agent" — but they are DIFFERENT answers (in-deployment and in-process vs
 * external and over HTTP), and they persist through different endpoints. These
 * pin both halves of that.
 */
describe("ChannelsTab — the A2A protocol switch", () => {
  it("renders inside the Agent-to-Agent section, not as a section of its own", async () => {
    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    const section = screen.getByText("channels.tab.agent").closest("section")!;
    expect(within(section).getByText("channels.tab.a2a")).toBeInTheDocument();
    // Two switches, one section: the internal channel and the external protocol.
    expect(within(section).getAllByRole("switch")).toHaveLength(2);
  });

  it("persists through the INSTANCE endpoint, never the channel one", async () => {
    mockInstanceUpdate.mockResolvedValue({ instance: { a2aEnabled: true } });
    render(<ChannelsTab slug="a1" instance={INSTANCE} onInstanceUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText("channels.tab.agent")).toBeInTheDocument());

    const section = screen.getByText("channels.tab.agent").closest("section")!;
    const [, a2aSwitch] = Array.from(section.querySelectorAll('[role="switch"]'));
    await userEvent.click(a2aSwitch as HTMLElement);
    await userEvent.click(await screen.findByRole("button", { name: "common.saveSingle" }));

    await waitFor(() => expect(mockInstanceUpdate).toHaveBeenCalledWith("a1", { a2aEnabled: true }));
    // The channel endpoint must NOT have been written to — one button, one resource.
    expect(mockSet).not.toHaveBeenCalled();
  });
});
