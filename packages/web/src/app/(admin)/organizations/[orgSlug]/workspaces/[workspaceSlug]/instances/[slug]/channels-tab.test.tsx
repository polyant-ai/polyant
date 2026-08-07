// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tests for the Channels tab, which had none — which is why the "no Delete for a
 * config-less channel" gate shipped landed on the wrong element: it was applied
 * to the status Badge instead of the delete dialog, with the comment explaining
 * it sitting above the badge it was not about. So Agent-to-Agent lost its
 * enabled/disabled badge AND kept its trash button, which only duplicated the
 * switch beside it.
 *
 * This tab renders exactly ONE channel (`channelType` is required), so there is
 * one section per render and no per-section heading to look a control up by.
 */

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelsTab } from "./channels-tab";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
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
  return { channelType, enabled, config: {} } as unknown as ChannelConfig;
}

/** Only `a2aEnabled` is read by the component; the cast keeps the fixture honest
 *  about that instead of stubbing forty unrelated instance fields. */
const INSTANCE = { a2aEnabled: false } as never;

/**
 * The Save this tab registers is rendered by the PAGE HEADER, which is not in the
 * tree here — so the provider alone gives nothing to click. This stands in for the
 * header: same contract (`isDirty`, `saving`, `onSave`), one button.
 */
function SaveHarness() {
  const { saveAction } = usePageActions();
  if (!saveAction?.isDirty) return null;
  return (
    <button onClick={() => void saveAction.onSave()} disabled={saveAction.saving}>
      save
    </button>
  );
}

/** The tab's save lives in the page header, so the provider must be present. */
function renderTab(channelType: string) {
  return render(
    <PageActionsProvider>
      <ChannelsTab
        slug="a1"
        channelType={channelType}
        instance={INSTANCE}
        onInstanceUpdate={() => {}}
      />
      <SaveHarness />
    </PageActionsProvider>,
  );
}

/** The one section this render produced. */
async function section(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector("section")).not.toBeNull());
  return document.querySelector("section") as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({ channels: [] });
  mockSet.mockResolvedValue({ channel: null });
  mockDelete.mockResolvedValue({ deleted: true });
});

describe("ChannelsTab — the switch is the only state control", () => {
  /*
    Delete is GONE from every channel, and so is the state badge.

    The trash removed the channel's stored config, which to the person looking at
    it was indistinguishable from switching the channel off: two controls for one
    apparent state, and the destructive-looking one was the only way to find out
    they differed. The badge, meanwhile, said "Abilitato" — which is what the
    switch beside it already showed — and only on channels that happened to be
    configured, which is why some sections had one and others did not.

    What replaced both: the word On/Off next to the switch, and the picker's live
    dot one level up.
  */
  it("offers no Delete, for any channel", async () => {
    mockList.mockResolvedValue({ channels: [channel("telegram", true)] });

    renderTab("telegram");

    expect((await section()).querySelector("button.text-destructive")).toBeNull();
  });

  it("reads out the state beside the switch", async () => {
    mockList.mockResolvedValue({ channels: [channel("telegram", true)] });

    renderTab("telegram");

    await waitFor(() => expect(screen.getByText("common.on")).toBeInTheDocument());
    expect(screen.queryByText("channels.tab.enabled")).not.toBeInTheDocument();
  });

  it("says Off for a channel that is configured but switched off", async () => {
    mockList.mockResolvedValue({ channels: [channel("telegram", false)] });

    renderTab("telegram");

    await waitFor(() => expect(screen.getByText("common.off")).toBeInTheDocument());
  });
});

describe("ChannelsTab — nothing is persisted without an explicit save", () => {
  it("writes nothing on mount", async () => {
    mockList.mockResolvedValue({ channels: [channel("agent", true)] });

    renderTab("agent");
    await section();

    // The config-less channel used to PERSIST on the switch flick; a write on
    // mount is the same class of surprise.
    expect(mockSet).not.toHaveBeenCalled();
  });
});

/**
 * A2A sits under Agent-to-Agent because both answer "who else may drive this
 * agent" — but they are DIFFERENT answers (in-deployment and in-process vs
 * external and over HTTP), and they persist through different endpoints.
 */
describe("ChannelsTab — the A2A protocol switch", () => {
  it("appears in the Agent-to-Agent section and nowhere else", async () => {
    renderTab("agent");
    expect(within(await section()).getByText("channels.tab.a2a")).toBeInTheDocument();

    cleanup();
    renderTab("telegram");
    expect(within(await section()).queryByText("channels.tab.a2a")).not.toBeInTheDocument();
  });

  it("persists through the INSTANCE endpoint, never the channel one", async () => {
    mockInstanceUpdate.mockResolvedValue({ instance: { a2aEnabled: true } });
    renderTab("agent");

    // ONE switch left in this section: the channel's own state is the On/Off pair
    // of buttons, and the switch is the external protocol. Two controls of two
    // shapes, deliberately — a channel's state reads the same on every channel,
    // while A2A is a capability like memory or knowledge, and those are switches.
    await userEvent.click(within(await section()).getByRole("switch"));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mockInstanceUpdate).toHaveBeenCalledWith("a1", { a2aEnabled: true }));
    // Only the resource that changed is written — the channel was left alone.
    expect(mockSet).not.toHaveBeenCalled();
  });
});
