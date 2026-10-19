// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelsSection } from "./channels-section";
import { PageActionsProvider } from "./page-actions-context";
import type { Instance } from "@/lib/api";

const { mockChannelsList } = vi.hoisted(() => ({ mockChannelsList: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: {
    channels: {
      list: (...a: unknown[]) => mockChannelsList(...a),
      slackWebhookUrl: vi.fn().mockResolvedValue({ webhookUrl: "" }),
    },
    secrets: { list: vi.fn().mockResolvedValue({ secrets: [] }) },
  },
  getUserErrorMessage: (_e: unknown, d: string) => d,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en", setLocale: vi.fn() }),
}));

const instance = { slug: "bot-1", authEnabled: false, a2aEnabled: false } as Instance;

describe("ChannelsSection — how many times the channel list is read", () => {
  it("reads it once on opening and never again while moving between channels", async () => {
    mockChannelsList.mockResolvedValue({ channels: [{ channelType: "telegram", enabled: true, config: {} }] });
    const user = userEvent.setup();
    render(
      <PageActionsProvider>
        <ChannelsSection instance={instance} onUpdate={vi.fn()} />
      </PageActionsProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("channels.tab.webEnabled")).not.toBeDisabled());

    for (const channel of ["telegram", "slack", "whatsapp", "agent", "web"]) {
      await user.click(screen.getByRole("button", { name: `channels.tab.${channel}` }));
    }

    expect(mockChannelsList).toHaveBeenCalledTimes(1);
  });
});
