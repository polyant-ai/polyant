// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConversationListItem, Instance } from "@/lib/api";

// ── Mocks ────────────────────────────────────────────────────────────

const mockConversationsList = vi.fn();
const mockInstancesList = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    instances: { list: (...args: unknown[]) => mockInstancesList(...args) },
    conversations: { list: (...args: unknown[]) => mockConversationsList(...args) },
  },
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

vi.mock("@/lib/format", () => ({
  formatRelativeTime: vi.fn(() => "just now"),
  truncate: vi.fn((text: string) => text),
}));

const mockPaginationFns = vi.hoisted(() => ({
  setPage: vi.fn(),
  setSearch: vi.fn(),
  setTotal: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/hooks/use-pagination", () => ({
  usePagination: vi.fn(() => ({
    page: 1,
    setPage: mockPaginationFns.setPage,
    search: "",
    setSearch: mockPaginationFns.setSearch,
    debouncedSearch: "",
    totalPages: 1,
    setTotal: mockPaginationFns.setTotal,
    offset: 0,
    reset: mockPaginationFns.reset,
  })),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

import ConversationsPage from "./page";

// ── Helpers ──────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: "c1",
    conversationId: "conv-1",
    title: "Test Conversation",
    summary: "A summary",
    instanceId: "inst-1",
    instanceName: "My Instance",
    messageCount: 5,
    totalTokens: 1200,
    totalCost: 0.0035,
    conversationTokens: 1000,
    conversationCost: 0.003,
    serviceTokens: 200,
    serviceCost: 0.0005,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "my-instance",
    name: "My Instance",
    description: null,
    status: "active",
    provider: "openai",
    model: "gpt-4o",
    memoryEnabled: false,
    knowledgeEnabled: false,
    langsmithEnabled: false,
    langsmithProject: null,
    authEnabled: false,
    thinkingEnabled: false,
    stateInPromptEnabled: false,
    toolResultsInHistoryEnabled: false,
    debugEnabled: false,
    sttProvider: "openai",
    icon: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ConversationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstancesList.mockResolvedValue({ instances: [] });
    mockConversationsList.mockResolvedValue({
      conversations: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
  });

  it("renders the page title and subtitle", async () => {
    render(<ConversationsPage />);

    expect(screen.getByText("conversations.title")).toBeInTheDocument();
    expect(screen.getByText("conversations.subtitle")).toBeInTheDocument();
  });

  it("shows loading state initially", () => {
    // Make the API call hang so loading stays visible
    mockConversationsList.mockReturnValue(new Promise(() => {}));
    render(<ConversationsPage />);

    expect(screen.getByText("common.loading")).toBeInTheDocument();
  });

  it("shows empty state when no conversations are returned", async () => {
    render(<ConversationsPage />);

    await waitFor(() => {
      expect(screen.getByText("conversations.empty.title")).toBeInTheDocument();
    });
    expect(screen.getByText("conversations.empty.description")).toBeInTheDocument();
  });

  it("renders conversations in a table when data is returned", async () => {
    const conv = makeConversation();
    mockConversationsList.mockResolvedValue({
      conversations: [conv],
      total: 1,
      limit: 20,
      offset: 0,
    });

    render(<ConversationsPage />);

    await waitFor(() => {
      expect(screen.getByText("Test Conversation")).toBeInTheDocument();
    });

    // Instance badge
    expect(screen.getByText("My Instance")).toBeInTheDocument();

    // Message count
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("links each conversation to its detail page", async () => {
    const conv = makeConversation({ conversationId: "conv-abc" });
    mockConversationsList.mockResolvedValue({
      conversations: [conv],
      total: 1,
      limit: 20,
      offset: 0,
    });

    render(<ConversationsPage />);

    await waitFor(() => {
      expect(screen.getByText("Test Conversation")).toBeInTheDocument();
    });

    const link = screen.getByText("Test Conversation").closest("a");
    expect(link).toHaveAttribute("href", "/conversations/conv-abc");
  });

  it("fetches instances for the filter dropdown", async () => {
    const instance = makeInstance();
    mockInstancesList.mockResolvedValue({ instances: [instance] });

    render(<ConversationsPage />);

    await waitFor(() => {
      expect(mockInstancesList).toHaveBeenCalledTimes(1);
    });
  });

  it("calls conversations.list with default params on mount", async () => {
    render(<ConversationsPage />);

    await waitFor(() => {
      expect(mockConversationsList).toHaveBeenCalledWith({
        instanceId: undefined,
        search: undefined,
        limit: 20,
        offset: 0,
      });
    });
  });

  it("shows the search input", () => {
    render(<ConversationsPage />);

    expect(
      screen.getByPlaceholderText("conversations.searchPlaceholder"),
    ).toBeInTheDocument();
  });

  it("shows 'new chat' fallback for conversations without title or summary", async () => {
    const conv = makeConversation({ title: null, summary: null });
    mockConversationsList.mockResolvedValue({
      conversations: [conv],
      total: 1,
      limit: 20,
      offset: 0,
    });

    render(<ConversationsPage />);

    await waitFor(() => {
      expect(screen.getByText("conversations.newChat")).toBeInTheDocument();
    });
  });
});
