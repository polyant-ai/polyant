// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => key }),
}));
vi.mock("./instance-selector", () => ({
  InstanceSelector: ({ onNameChange }: { onNameChange?: (name: string | null) => void }) => (
    <button onClick={() => onNameChange?.("Sofia")}>pick</button>
  ),
}));
vi.mock("./chat-sidebar", () => ({ ChatHistoryDialog: () => <div /> }));
vi.mock("./chat-input", () => ({ ChatInput: () => <div /> }));
vi.mock("@/components/messages/debug-sheet", () => ({ DebugSheet: () => null }));
vi.mock("@/components/messages/context-store-sheet", () => ({ ContextStoreSheet: () => null }));
vi.mock("@/hooks/use-detailed-view", () => ({ useDetailedView: () => [false, vi.fn()] }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatArea } from "./chat-area";

describe("ChatArea", () => {
  it("has no agent key field: the playground rides the panel session", () => {
    render(
      <TooltipProvider><ChatArea
        messages={[]} historicalHookExecutions={[]} isStreaming={false} instanceSlug="shop" error={null}
        conversations={[]} conversationsLoading={false} activeConversationId={null}
        onSend={vi.fn()} onStop={vi.fn()} onInstanceChange={vi.fn()} onNewChat={vi.fn()} onSelectConversation={vi.fn()}
      /></TooltipProvider>,
    );
    expect(screen.queryByPlaceholderText(/key|token|chiave/i)).toBeNull();
    expect(screen.queryByText("playground.authKeyToggle")).toBeNull();
  });
});

describe("ChatArea empty state", () => {
  const renderArea = () =>
    render(
      <TooltipProvider><ChatArea
        messages={[]} historicalHookExecutions={[]} isStreaming={false} instanceSlug="shop" error={null}
        conversations={[]} conversationsLoading={false} activeConversationId={null}
        onSend={vi.fn()} onStop={vi.fn()} onInstanceChange={vi.fn()} onNewChat={vi.fn()} onSelectConversation={vi.fn()}
      /></TooltipProvider>,
    );

  it("keeps the generic hint while no agent is picked", () => {
    renderArea();
    expect(screen.getByText("playground.emptyHint")).toBeInTheDocument();
  });

  it("names the picked agent in the hint instead of telling the reader to select one", async () => {
    renderArea();
    await userEvent.setup().click(screen.getByText("pick"));
    // Catches the hint still asking to select an agent when one is already chosen.
    expect(screen.getByText("playground.emptyHintAgent")).toBeInTheDocument();
    expect(screen.queryByText("playground.emptyHint")).toBeNull();
  });
});
