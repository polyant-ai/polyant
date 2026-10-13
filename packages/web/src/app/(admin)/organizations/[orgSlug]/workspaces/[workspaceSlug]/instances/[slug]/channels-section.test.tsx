// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import { ChannelsSection } from "./channels-section";
import { PageActionsProvider } from "./page-actions-context";
import type { Instance } from "@/lib/api";

const { mockChannelsList } = vi.hoisted(() => ({ mockChannelsList: vi.fn() }));

vi.mock("./channel-web-tab", () => ({ ChannelWebTab: () => <div>web-panel</div> }));
vi.mock("./channels-tab", () => ({ ChannelsTab: () => <div>other-panel</div> }));
vi.mock("@/lib/api", () => ({
  api: { channels: { list: (...a: unknown[]) => mockChannelsList(...a) } },
}));
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en", setLocale: vi.fn() }),
}));

const instance = { slug: "bot-1", authEnabled: true } as Instance;

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
    mockChannelsList.mockResolvedValue({ channels: [{ channelType: "web", enabled: true, config: {} }] });
    render(
      <PageActionsProvider>
        <ChannelsSection instance={instance} onUpdate={vi.fn()} />
      </PageActionsProvider>,
    );

    await waitFor(() => expect(dotOf("channels.tab.web")).toHaveAttribute("data-state", "live"));
  });
});
