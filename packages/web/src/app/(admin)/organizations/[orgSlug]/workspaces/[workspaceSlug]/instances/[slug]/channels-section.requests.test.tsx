// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelsSection } from "./channels-section";
import { PageActionsProvider } from "./page-actions-context";
import { makeChannel, makeInstance } from "@/test-fixtures/api";

type Api = typeof import("@/lib/api").api;
const { mockChannelsList } = vi.hoisted(() => ({ mockChannelsList: vi.fn<Api["channels"]["list"]>() }));

vi.mock("@/lib/api", () => ({
  api: {
    channels: {
      list: (...a: Parameters<Api["channels"]["list"]>) => mockChannelsList(...a),
      slackWebhookUrl: vi.fn<Api["channels"]["slackWebhookUrl"]>().mockResolvedValue({ webhookUrl: "" }),
    },
    secrets: { list: vi.fn<Api["secrets"]["list"]>().mockResolvedValue({ secrets: [] }) },
  },
  getUserErrorMessage: (_e: unknown, d: string) => d,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en", setLocale: vi.fn() }),
}));

const instance = makeInstance({ slug: "bot-1", authEnabled: false, a2aEnabled: false });

describe("ChannelsSection — how many times the channel list is read", () => {
  it("reads it once on opening and never again while moving between channels", async () => {
    mockChannelsList.mockResolvedValue({ channels: [makeChannel({ channelType: "telegram" })] });
    const user = userEvent.setup();
    render(
      <PageActionsProvider>
        <ChannelsSection instance={instance} onUpdate={vi.fn()} />
      </PageActionsProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "common.on" })).not.toBeDisabled());

    for (const channel of ["telegram", "slack", "whatsapp", "agent", "web"]) {
      await user.click(screen.getByRole("button", { name: `channels.tab.${channel}` }));
    }

    expect(mockChannelsList).toHaveBeenCalledTimes(1);
  });

  it("says the list could not be read, and reads it again on retry", async () => {
    mockChannelsList.mockRejectedValueOnce(new Error("boom"));
    mockChannelsList.mockResolvedValue({ channels: [] });
    const user = userEvent.setup();
    render(
      <PageActionsProvider>
        <ChannelsSection instance={instance} onUpdate={vi.fn()} />
      </PageActionsProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("common.loadFailed");
    await user.click(screen.getByRole("button", { name: "common.retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(mockChannelsList).toHaveBeenCalledTimes(2);
  });
});
