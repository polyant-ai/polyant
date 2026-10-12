// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockChannels, chatState } = vi.hoisted(() => ({
  mockChannels: vi.fn(),
  chatState: { instanceSlug: "shop" },
}));
vi.mock("@/lib/api", () => ({ api: { channels: { list: mockChannels } } }));
vi.mock("./_hooks/use-conversations", () => ({
  useConversations: () => ({ conversations: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("./_hooks/use-chat", () => ({
  useChat: () => ({
    state: { messages: [], historicalHookExecutions: [], isStreaming: false, instanceSlug: chatState.instanceSlug, error: null, conversationId: null },
    sendMessage: vi.fn(), newChat: vi.fn(), setInstance: vi.fn(), loadConversation: vi.fn(), stopStreaming: vi.fn(),
  }),
}));
vi.mock("./_components/chat-area", () => ({
  ChatArea: (p: { webOff: boolean; authToken: string; onAuthTokenChange: (t: string) => void }) => (
    <div>
      <span data-testid="web">{p.webOff ? "off" : "on"}</span>
      <span data-testid="key">{p.authToken}</span>
      <button onClick={() => p.onAuthTokenChange("k1")}>type</button>
    </div>
  ),
}));

import PlaygroundPage from "./page";

describe("PlaygroundPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("flags Web off when the agent's web channel is missing or disabled", async () => {
    mockChannels.mockResolvedValue({ channels: [{ channelType: "web", enabled: false }] });
    render(<PlaygroundPage />);
    await waitFor(() => expect(screen.getByTestId("web")).toHaveTextContent("off"));
  });

  it("does not flag Web off when the channel is enabled", async () => {
    mockChannels.mockResolvedValue({ channels: [{ channelType: "web", enabled: true }] });
    render(<PlaygroundPage />);
    await waitFor(() => expect(mockChannels).toHaveBeenCalledWith("shop"));
    expect(screen.getByTestId("web")).toHaveTextContent("on");
  });

  it("keeps the typed key per agent in localStorage (playground_auth_<slug>)", async () => {
    mockChannels.mockResolvedValue({ channels: [{ channelType: "web", enabled: true }] });
    localStorage.setItem("playground_auth_shop", "stored");
    render(<PlaygroundPage />);
    await waitFor(() => expect(screen.getByTestId("key")).toHaveTextContent("stored"));
    screen.getByText("type").click();
    await waitFor(() => expect(localStorage.getItem("playground_auth_shop")).toBe("k1"));
  });
});
