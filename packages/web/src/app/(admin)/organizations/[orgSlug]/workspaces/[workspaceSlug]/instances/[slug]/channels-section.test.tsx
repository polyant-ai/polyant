// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import { ChannelsSection } from "./channels-section";
import { PageActionsProvider } from "./page-actions-context";
import { makeChannel, makeInstance } from "@/test-fixtures/api";

const { mockChannelsList } = vi.hoisted(() => ({
  mockChannelsList: vi.fn<typeof import("@/lib/api").api.channels.list>(),
}));

vi.mock("./channel-web-tab", () => ({ ChannelWebTab: () => <div>web-panel</div> }));
vi.mock("./channels-tab", () => ({ ChannelsTab: () => <div>other-panel</div> }));
vi.mock("@/lib/api", () => ({
  api: { channels: { list: mockChannelsList } },
}));
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en", setLocale: vi.fn() }),
}));

const instance = makeInstance({ slug: "bot-1", authEnabled: true });

function dotOf(label: string): HTMLElement {
  return screen.getByText(label).querySelector("span[aria-hidden]") as HTMLElement;
}

describe("ChannelsSection — Web is a channel", () => {
  it("lists Web first, selected, and shows it off when the agent has no web row", async () => {
    mockChannelsList.mockResolvedValue({ channels: [] });
    render(
      <PageActionsProvider>
        <ChannelsSection instance={instance} onUpdate={vi.fn()} />
      </PageActionsProvider>,
    );

    expect(screen.getByText("web-panel")).toBeInTheDocument();
    await waitFor(() => expect(mockChannelsList).toHaveBeenCalled());
    expect(dotOf("channels.tab.web")).toHaveAttribute("data-state", "off");
  });

  it("shows Web live when its channel row is enabled", async () => {
    mockChannelsList.mockResolvedValue({ channels: [makeChannel({ channelType: "web" })] });
    render(
      <PageActionsProvider>
        <ChannelsSection instance={instance} onUpdate={vi.fn()} />
      </PageActionsProvider>,
    );

    await waitFor(() => expect(dotOf("channels.tab.web")).toHaveAttribute("data-state", "live"));
  });
});
