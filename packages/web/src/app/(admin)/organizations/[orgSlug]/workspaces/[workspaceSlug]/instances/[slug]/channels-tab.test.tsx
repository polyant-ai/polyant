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

// `t` must keep ONE identity across renders, the way the real provider's does:
// `ChannelsTab`'s list-loading effect depends on `[slug, t]`, so a `t` that
// changes identity on every call (as a fresh arrow function would) reruns
// that effect on every render and wipes any just-typed field before the test
// can observe it.
const stableT = (key: string) => key;

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: stableT, locale: "en", setLocale: vi.fn() })),
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
      webhookUrl: vi.fn().mockResolvedValue({ webhookUrl: "" }),
      rotateWebhookSecret: vi.fn().mockResolvedValue({ webhookUrl: "" }),
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
 * Safety net for the render-section extraction (issue #287): pins the field's
 * dirty tracking and the eye mask/reveal, neither of which had a test before
 * the refactor. Both live in the block being pulled out of `ChannelsTab`.
 */
describe("ChannelsTab — the generic field-list section", () => {
  it("shows no save action until a field is edited, then shows it dirty", async () => {
    mockList.mockResolvedValue({ channels: [channel("telegram", true)] });

    renderTab("telegram");
    await section();

    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText("channels.tab.telegramAllowedUserIds"),
      "123",
    );

    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("masks a sensitive field behind the eye toggle and reveals it on click", async () => {
    mockList.mockResolvedValue({
      channels: [
        { channelType: "telegram", enabled: true, config: { botToken: "sk-masked-1234" } } as unknown as ChannelConfig,
      ],
    });

    renderTab("telegram");
    await section();

    const input = screen.getByLabelText("channels.tab.telegramBotToken") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.placeholder).toBe("sk-masked-1234");

    await userEvent.click(screen.getByLabelText("common.show"));

    expect(input.type).toBe("text");
    expect(screen.getByLabelText("common.hide")).toBeInTheDocument();
  });
});

/**
 * WhatsApp does not fit the generic field-list section (two mutually
 * exclusive credential modes plus a secret-bearing webhook URL), so it
 * renders through its own dedicated card instead.
 */
describe("ChannelsTab — WhatsApp renders through its dedicated card", () => {
  it("renders the WhatsApp card, not the generic field-list section", async () => {
    mockList.mockResolvedValue({ channels: [channel("whatsapp", true)] });

    renderTab("whatsapp");

    // The dedicated card has no On/Off button pair (it uses its own Switch)
    // and no generic "channels.tab.whatsappAccountSid" field label from the
    // field-list renderer's translation key set — it renders its own fields.
    await waitFor(() => expect(screen.getByRole("switch")).toBeInTheDocument());
    expect(screen.queryByText("common.on")).not.toBeInTheDocument();
    expect(screen.queryByText("common.off")).not.toBeInTheDocument();
  });

  it("still renders the generic section for the other channels", async () => {
    mockList.mockResolvedValue({ channels: [channel("telegram", true)] });

    renderTab("telegram");

    await waitFor(() => expect(screen.getByText("common.on")).toBeInTheDocument());
  });

  it("refreshes the channel list after the card reports a change", async () => {
    mockList.mockResolvedValue({ channels: [] });

    renderTab("whatsapp");
    await waitFor(() => expect(screen.getByLabelText("channels.tab.whatsappAccountSid")).toBeInTheDocument());
    const callsBeforeSave = mockList.mock.calls.length;

    mockSet.mockResolvedValue({ channel: channel("whatsapp", true), webhookUrl: undefined });
    // Fill the minimum authToken-mode fields the card renders and save via
    // its own inline button — exercising `onChanged`, which this tab wires
    // back to a fresh `channels.list()` call.
    await userEvent.type(screen.getByLabelText("channels.tab.whatsappAccountSid"), "AC0");
    await userEvent.type(screen.getByLabelText("channels.tab.whatsappAuthToken"), "tok");
    await userEvent.type(screen.getByLabelText("channels.tab.whatsappNumber"), "+1");
    await userEvent.click(screen.getByRole("button", { name: "common.saveSingle" }));

    await waitFor(() => expect(mockList.mock.calls.length).toBeGreaterThan(callsBeforeSave));
  });

  /**
   * `channel` — what the card is told via its prop — must be derived from a
   * freshly re-fetched list, not from stale state. A refactor that keeps
   * calling `initStates(res.channels)` in `onChanged` but stops updating the
   * raw list (e.g. drops `setRawChannels`) would leave the card believing a
   * just-deleted channel is still configured, with no test catching it.
   */
  it("reflects a deletion reported through onChanged: the card goes from configured to unconfigured", async () => {
    // A stable implementation (not queued mockResolvedValueOnce calls) —
    // the list-loading effect can re-fire more than once as the card and
    // this tab settle, so a once-queue could be drained before the test
    // ever gets to click anything. Reading current mutable state on every
    // call is immune to how many times the effect happens to fire.
    let configured = true;
    mockList.mockImplementation(() =>
      Promise.resolve({ channels: configured ? [channel("whatsapp", true)] : [] }),
    );
    mockDelete.mockImplementation(() => {
      configured = false;
      return Promise.resolve({ deleted: true });
    });

    renderTab("whatsapp");

    // Configured: the card renders its destructive Trash trigger (icon-only,
    // so identified by the same class the rest of this file already uses).
    await waitFor(() => expect(document.querySelector("button.text-destructive")).not.toBeNull());

    await userEvent.click(document.querySelector("button.text-destructive") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "common.delete" }));

    // Unconfigured after the refresh the card's own onChanged triggered: the
    // Trash trigger (only rendered when `channel` is truthy) is gone.
    await waitFor(() => expect(document.querySelector("button.text-destructive")).toBeNull());
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
