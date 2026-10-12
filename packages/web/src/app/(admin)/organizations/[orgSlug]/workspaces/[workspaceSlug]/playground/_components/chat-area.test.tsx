// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ locale: "en", setLocale: vi.fn(), t: (key: string) => key }),
}));
vi.mock("./instance-selector", () => ({ InstanceSelector: () => <div /> }));
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
