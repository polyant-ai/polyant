// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeInstance } from "@/test-fixtures/api";
import { makeMemory, makeMemoryPage } from "@/test-fixtures/memory";

// ── Mocks ────────────────────────────────────────────────────────────

const { mockInstancesList, mockMemoriesList, mockMemoriesDelete } = vi.hoisted(() => ({
  mockInstancesList: vi.fn<typeof import("@/lib/api").api.instances.list>(),
  mockMemoriesList: vi.fn<typeof import("@/lib/api").api.memories.list>(),
  mockMemoriesDelete: vi.fn<typeof import("@/lib/api").api.memories.delete>(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    instances: { list: mockInstancesList },
    memories: {
      list: mockMemoriesList,
      delete: mockMemoriesDelete,
    },
  },
  getUserErrorMessage: vi.fn((_err: unknown, fallback: string) => fallback),
}));

// Stable identity — the source uses `t` in useCallback dependency arrays, so a
// freshly-created object per call would trigger an infinite re-render loop.
const i18nMock = {
  t: (key: string) => key,
  locale: "en",
  setLocale: vi.fn(),
};
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => i18nMock,
}));

vi.mock("@/lib/format", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/format")>()),
  formatRelativeTime: vi.fn(() => "2 hours ago"),
}));

const mockPaginationFns = vi.hoisted(() => ({
  setPage: vi.fn(),
  setSearch: vi.fn(),
}));

vi.mock("@/hooks/use-pagination", () => ({
  usePagination: vi.fn(() => ({
    page: 1,
    setPage: mockPaginationFns.setPage,
    search: "",
    setSearch: mockPaginationFns.setSearch,
    debouncedSearch: "",
    offset: 0,
  })),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the create drawer to avoid pulling in its dependencies
vi.mock("@/components/memory/create-memory-sheet", () => ({
  CreateMemorySheet: ({ open }: { open: boolean }) => (open ? <div data-testid="create-memory-sheet" /> : null),
}));

// The workspace now comes from the URL, so a component test that does not
// exercise workspace switching only needs the hook to answer something.
vi.mock("@/lib/tenant/use-workspace-slug", () => ({
  useWorkspaceSlug: () => "general",
}));

import { MemoryView } from "@/components/memory/memory-view";
import MemoryWorkspacePage from "./page";

/** The list on its own, as the agent's section shows it. */
function MemoryPage(props: { lockedInstanceId?: string }) {
  return <MemoryView createOpen={false} onCreateOpenChange={() => {}} {...props} />;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstancesList.mockResolvedValue({ instances: [] });
    mockMemoriesList.mockResolvedValue(makeMemoryPage());
  });

  /**
   * The title belongs to the PAGE, not to the list: the list is shared with the
   * agent's Attività section, which titles itself from the section registry. What
   * the shared view must still own is the agent picker — the thing the agent
   * section drops.
   */
  it("offers the agent picker when no agent is fixed", () => {
    render(<MemoryPage />);

    expect(screen.getByText("memory.selectInstance")).toBeInTheDocument();
  });

  it("drops the agent picker when an agent is fixed", () => {
    render(<MemoryPage lockedInstanceId="a1" />);

    expect(screen.queryByText("memory.selectInstance")).not.toBeInTheDocument();
  });

  it("puts the Add button in the page header, and it opens the create drawer", async () => {
    const user = userEvent.setup();
    render(<MemoryWorkspacePage />);
    expect(screen.queryByTestId("create-memory-sheet")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "memory.addMemory" }));

    expect(screen.getByTestId("create-memory-sheet")).toBeInTheDocument();
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

  it("preselects the first agent instead of opening on an empty page", async () => {
    mockInstancesList.mockResolvedValue({ instances: [makeInstance({ slug: "alpha", name: "Alpha" }), makeInstance({ slug: "beta", name: "Beta" })] });
    render(<MemoryPage />);

    // Catches the page opening blank and waiting for a pick before showing anything.
    await waitFor(() => expect(mockMemoriesList).toHaveBeenCalled());
    expect(mockMemoriesList.mock.calls[0][0]).toMatchObject({ instanceId: "alpha" });
    expect(screen.queryByText("memory.selectInstancePrompt")).not.toBeInTheDocument();
  });

  // The list must show the agent picked, even when the previous agent's
  // memories answer last.
  it("shows the memories of the agent picked, not of a slower previous one", async () => {
    mockInstancesList.mockResolvedValue({ instances: [makeInstance({ slug: "alpha", name: "Alpha" }), makeInstance({ slug: "beta", name: "Beta" })] });
    let answerAlpha: (value: Awaited<ReturnType<typeof mockMemoriesList>>) => void = () => {};
    mockMemoriesList.mockImplementation((params) =>
      params?.instanceId === "alpha"
        ? new Promise((resolve) => (answerAlpha = resolve))
        : Promise.resolve(makeMemoryPage([makeMemory({ id: "b1", content: "Beta memory" })])),
    );
    const user = userEvent.setup();
    render(<MemoryPage />);
    await waitFor(() => expect(mockMemoriesList).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "alpha" })));

    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Beta" }));
    expect(await screen.findByText("Beta memory")).toBeInTheDocument();

    answerAlpha(makeMemoryPage([makeMemory({ id: "a1", content: "Alpha memory" })]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Alpha memory")).not.toBeInTheDocument();
    expect(screen.getByText("Beta memory")).toBeInTheDocument();
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

  describe("with memories", () => {
    const MEMORIES = [
      makeMemory({ id: "m1", content: "Lives in Rome", category: "fact", importance: 6 }),
      makeMemory({ id: "m2", content: "Prefers Italian", category: "preference", importance: 3, updatedAt: "2026-09-01T00:00:00Z" }),
    ];

    beforeEach(() => {
      mockMemoriesList.mockResolvedValue(makeMemoryPage(MEMORIES));
      mockMemoriesDelete.mockResolvedValue({ deleted: true });
    });

    it("keeps the engine's newest-first order rather than sorting by text", async () => {
      render(<MemoryPage lockedInstanceId="a1" />);
      await screen.findByText("Lives in Rome");

      const rows = screen.getAllByRole("row").slice(1);
      expect(rows[0]).toHaveTextContent("Lives in Rome");
      expect(rows[1]).toHaveTextContent("Prefers Italian");
    });

    it("offers no delete on the row; the memory's drawer has it, behind a confirmation", async () => {
      const user = userEvent.setup();
      render(<MemoryPage lockedInstanceId="a1" />);
      await screen.findByText("Lives in Rome");
      expect(screen.queryByRole("button", { name: "common.delete" })).not.toBeInTheDocument();

      await user.click(screen.getAllByRole("row")[1]);
      const drawer = await screen.findByRole("dialog");
      await user.click(within(drawer).getByRole("button", { name: "common.delete" }));
      expect(mockMemoriesDelete).not.toHaveBeenCalled();
      await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "common.delete" }));

      await waitFor(() => expect(mockMemoriesDelete).toHaveBeenCalledWith("m1"));
    });

    it("types into the shared search box, which the engine answers", async () => {
      const user = userEvent.setup();
      render(<MemoryPage lockedInstanceId="a1" />);
      await screen.findByText("Lives in Rome");

      await user.type(screen.getByRole("searchbox"), "r");

      expect(mockPaginationFns.setSearch).toHaveBeenCalledWith("r");
    });

    it("says the load failed, with a retry, instead of an empty list", async () => {
      mockMemoriesList.mockRejectedValue(new Error("down"));
      render(<MemoryPage lockedInstanceId="a1" />);

      expect(await screen.findByRole("alert")).toHaveTextContent("common.loadFailed");
      expect(screen.queryByText("memory.empty.title")).not.toBeInTheDocument();
    });
  });
});
