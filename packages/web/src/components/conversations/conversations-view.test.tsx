// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockList, mockInstances, mockPush, mockSetSearch } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockInstances: vi.fn(),
  mockPush: vi.fn(),
  mockSetSearch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ orgSlug: "acme", workspaceSlug: "sales" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/tenant/use-workspace-slug", () => ({ useWorkspaceSlug: () => "sales" }));
vi.mock("@/lib/api", () => ({
  api: {
    conversations: { list: (...a: unknown[]) => mockList(...a) },
    instances: { list: (...a: unknown[]) => mockInstances(...a) },
  },
  getUserErrorMessage: (_e: unknown, fallback: string) => fallback,
}));
const i18n = vi.hoisted(() => ({ t: (k: string) => k, locale: "en" }));
vi.mock("@/lib/i18n/context", () => ({ useI18n: () => i18n }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real hook's setters keep their identity across renders; so do these.
const pagination = vi.hoisted(() => ({ search: "", page: 1, setPage: vi.fn() }));
vi.mock("@/hooks/use-pagination", () => ({
  usePagination: () => ({
    page: pagination.page,
    setPage: pagination.setPage,
    search: pagination.search,
    setSearch: mockSetSearch,
    debouncedSearch: pagination.search,
    offset: (pagination.page - 1) * 20,
  }),
}));

import { ConversationsView } from "./conversations-view";

function conv(over: Record<string, unknown>) {
  return {
    id: "1",
    conversationId: "bot:web:1",
    title: "Refund question",
    summary: "Customer asks for a refund",
    instanceName: "Support Bot",
    userIdentifier: "ada",
    channel: null,
    messageCount: 4,
    conversationTokens: 100,
    serviceTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    conversationCost: 0.01,
    serviceCost: 0,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

describe("ConversationsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pagination.search = "";
    pagination.page = 1;
    mockInstances.mockResolvedValue({ instances: [] });
    mockList.mockResolvedValue({
      conversations: [conv({}), conv({ id: "2", conversationId: "bot:web:2", title: "Another" })],
      total: 2,
    });
  });

  it("links the title to the conversation's page and goes there from the rest of the row", async () => {
    const user = userEvent.setup();
    render(<ConversationsView />);

    const link = await screen.findByRole("link", { name: "Refund question" });
    expect(link).toHaveAttribute("href", "/organizations/acme/workspaces/sales/conversations/bot%3Aweb%3A1");

    await user.click(screen.getAllByText("ada")[0]);

    expect(mockPush).toHaveBeenCalledWith("/organizations/acme/workspaces/sales/conversations/bot%3Aweb%3A1");
  });

  it("keeps the engine's order, most recent first, instead of sorting by title", async () => {
    mockList.mockResolvedValue({
      conversations: [conv({ title: "Zulu" }), conv({ id: "2", conversationId: "b", title: "Alpha" })],
      total: 2,
    });
    render(<ConversationsView />);
    await screen.findByText("Zulu");

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Zulu");
    expect(rows[1]).toHaveTextContent("Alpha");
  });

  it("shows the summary under the title as the row's second line", async () => {
    render(<ConversationsView />);
    expect(await screen.findAllByText("Customer asks for a refund")).not.toHaveLength(0);
  });

  it("sends what is typed in the shared search box to the engine's search", async () => {
    const user = userEvent.setup();
    render(<ConversationsView />);
    await screen.findByText("Refund question");

    await user.type(screen.getByRole("searchbox"), "r");

    expect(mockSetSearch).toHaveBeenCalledWith("r");
  });

  it("says nothing matched when a search has no result, and the plain empty state otherwise", async () => {
    mockList.mockResolvedValue({ conversations: [], total: 0 });
    const { unmount } = render(<ConversationsView />);
    expect(await screen.findByText("conversations.empty.title")).toBeInTheDocument();
    unmount();

    pagination.search = "zzz";
    render(<ConversationsView />);
    expect(await screen.findByText("conversations.empty.searchTitle")).toBeInTheDocument();
  });

  it("states a failed load with a retry instead of an empty table", async () => {
    mockList.mockRejectedValue(new Error("down"));
    const user = userEvent.setup();
    render(<ConversationsView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("common.loadFailed");
    mockList.mockResolvedValue({ conversations: [conv({})], total: 1 });
    await user.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(screen.getByText("Refund question")).toBeInTheDocument());
  });

  // A slow search that answers after the next one must not replace its rows.
  it("shows the rows of the search on screen, not of a slower earlier one", async () => {
    let answerFirst: (value: unknown) => void = () => {};
    mockList.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
    mockList.mockResolvedValueOnce({ conversations: [conv({ title: "Fresh" })], total: 1 });
    const { rerender } = render(<ConversationsView />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    pagination.search = "fresh";
    rerender(<ConversationsView />);
    expect(await screen.findByText("Fresh")).toBeInTheDocument();

    answerFirst({ conversations: [conv({ id: "9", conversationId: "old", title: "Stale" })], total: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(screen.getByText("Fresh")).toBeInTheDocument();
  });

  // Moving to another page keeps the table and its pager in place until the new rows arrive.
  it("keeps the current rows and the pager on screen while the next page loads", async () => {
    mockList.mockResolvedValueOnce({ conversations: [conv({ title: "First page" })], total: 45 });
    mockList.mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(<ConversationsView />);
    expect(await screen.findByText("First page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.next" })).toBeInTheDocument();

    pagination.page = 2;
    rerender(<ConversationsView />);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));

    expect(screen.getByText("First page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "common.next" })).toBeInTheDocument();
  });

  it("keeps the agent in the link on the agent tab", async () => {
    render(<ConversationsView lockedInstanceId="bot" />);
    const link = await screen.findByRole("link", { name: "Refund question" });
    expect(link.getAttribute("href")).toContain("instanceId=bot");
  });

  it("drops the agent column when the agent is fixed", async () => {
    render(<ConversationsView lockedInstanceId="bot" />);
    await screen.findByText("Refund question");
    expect(screen.queryByText("conversations.table.instance")).not.toBeInTheDocument();
  });
});
