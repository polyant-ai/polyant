// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Instance, Memory } from "@/lib/api";

// ── Mocks ────────────────────────────────────────────────────────────

const mockInstancesList = vi.fn();
const mockMemoriesList = vi.fn();
const mockMemoriesDelete = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    instances: { list: (...args: unknown[]) => mockInstancesList(...args) },
    memories: {
      list: (...args: unknown[]) => mockMemoriesList(...args),
      delete: (...args: unknown[]) => mockMemoriesDelete(...args),
    },
  },
  getUserErrorMessage: vi.fn((_err: unknown, fallback: string) => fallback),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

vi.mock("@/lib/format", () => ({
  formatRelativeTime: vi.fn(() => "2 hours ago"),
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

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the CreateMemoryDialog to avoid pulling in its dependencies
vi.mock("./create-memory-dialog", () => ({
  CreateMemoryDialog: () => <div data-testid="create-memory-dialog" />,
}));

import MemoryPage from "./page";

// ── Helpers ──────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "my-instance",
    name: "My Instance",
    description: null,
    status: "active",
    provider: "openai",
    model: "gpt-4o",
    memoryEnabled: true,
    knowledgeEnabled: false,
    langsmithEnabled: false,
    langsmithProject: null,
    authEnabled: false,
    thinkingEnabled: false,
    stateInPromptEnabled: false,
    toolResultsInHistoryEnabled: false,
    debugEnabled: false,
    optoutEnabled: false,
    optoutStopKeywords: [],
    optoutResumeKeywords: [],
    optoutClosingMessage: null,
    optoutResumeMessage: null,
    optoutInjectPromptHint: false,
    sttProvider: "openai",
    icon: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    agentId: "my-instance",
    content: "User prefers dark mode",
    category: "preference",
    importance: 7,
    sourceConversationId: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstancesList.mockResolvedValue({ agents: [] });
    mockMemoriesList.mockResolvedValue({
      memories: [],
      total: 0,
      limit: 20,
      offset: 0,
    });
  });

  it("renders the page title and subtitle", () => {
    render(<MemoryPage />);

    expect(screen.getByText("memory.title")).toBeInTheDocument();
    expect(screen.getByText("memory.subtitle")).toBeInTheDocument();
  });

  it("renders the 'Add Memory' button", () => {
    render(<MemoryPage />);

    expect(screen.getByText("memory.addMemory")).toBeInTheDocument();
  });

  it("shows 'select instance' prompt when no instance is selected", async () => {
    render(<MemoryPage />);

    await waitFor(() => {
      expect(
        screen.getByText("memory.selectInstancePrompt"),
      ).toBeInTheDocument();
    });
  });

  it("does NOT call memories.list when no instance filter is set", async () => {
    render(<MemoryPage />);

    // Wait for effects to flush
    await waitFor(() => {
      expect(screen.getByText("memory.selectInstancePrompt")).toBeInTheDocument();
    });

    expect(mockMemoriesList).not.toHaveBeenCalled();
  });

  it("fetches instances on mount for the filter dropdown", async () => {
    render(<MemoryPage />);

    await waitFor(() => {
      expect(mockInstancesList).toHaveBeenCalledTimes(1);
    });
  });

  it("shows the search input", () => {
    render(<MemoryPage />);

    expect(
      screen.getByPlaceholderText("memory.searchPlaceholder"),
    ).toBeInTheDocument();
  });

  it("renders the CreateMemoryDialog component", () => {
    render(<MemoryPage />);

    expect(screen.getByTestId("create-memory-dialog")).toBeInTheDocument();
  });
});
