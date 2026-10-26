// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateMemorySheet } from "./create-memory-sheet";
import type { Instance } from "@/lib/api";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

const createMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    memories: {
      create: (...args: unknown[]) => createMock(...args),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Fixtures ────────────────────────────────────────────────────────

const instances: Instance[] = [
  {
    id: "inst-1",
    slug: "bot-alpha",
    name: "Bot Alpha",
    description: null,
    status: "active",
    provider: null,
    model: null,
    effectiveProvider: "openai",
    effectiveModel: "gpt-4o",
    memoryEnabled: true,
    knowledgeEnabled: false,
    langsmithEnabled: false,
    langsmithProject: null,
    authEnabled: false,
    thinkingEnabled: false,
    stateInPromptEnabled: false,
    datetimeInjectionEnabled: true,
  datetimeTimezone: null,
  datetimeLocale: null,
  dedupSimilarityThreshold: null,
  messageSoftDebounceMs: null,
  messageTypingDelayMs: null,
  messageMaxRestarts: null,
    cacheEnabled: true,
    cacheTtl: "1h",
    a2aEnabled: false,
    toolResultsInHistoryEnabled: false,
    debugEnabled: false,
    attachmentStorageEnabled: false,
    optoutEnabled: false,
    optoutStopKeywords: [],
    optoutResumeKeywords: [],
    optoutClosingMessage: null,
    optoutResumeMessage: null,
    optoutInjectPromptHint: false,
    webContextFieldMapping: {},
    sttProvider: "openai",
    icon: null,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: "inst-2",
    slug: "bot-beta",
    name: "Bot Beta",
    description: null,
    status: "active",
    provider: null,
    model: null,
    effectiveProvider: "openai",
    effectiveModel: "gpt-4o",
    memoryEnabled: true,
    knowledgeEnabled: false,
    langsmithEnabled: false,
    langsmithProject: null,
    authEnabled: false,
    thinkingEnabled: false,
    stateInPromptEnabled: false,
    datetimeInjectionEnabled: true,
  datetimeTimezone: null,
  datetimeLocale: null,
  dedupSimilarityThreshold: null,
  messageSoftDebounceMs: null,
  messageTypingDelayMs: null,
  messageMaxRestarts: null,
    cacheEnabled: true,
    cacheTtl: "1h",
    a2aEnabled: false,
    toolResultsInHistoryEnabled: false,
    debugEnabled: false,
    attachmentStorageEnabled: false,
    optoutEnabled: false,
    optoutStopKeywords: [],
    optoutResumeKeywords: [],
    optoutClosingMessage: null,
    optoutResumeMessage: null,
    optoutInjectPromptHint: false,
    webContextFieldMapping: {},
    sttProvider: "openai",
    icon: null,
    createdAt: null,
    updatedAt: null,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

function renderSheet(
  props: Partial<React.ComponentProps<typeof CreateMemorySheet>> = {},
) {
  const defaults = {
    open: true,
    onOpenChange: vi.fn(),
    instances,
    onCreated: vi.fn(),
  };
  return { ...render(<CreateMemorySheet {...defaults} {...props} />), defaults };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("CreateMemorySheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the drawer title and description when open", () => {
    renderSheet();

    expect(screen.getByText("memory.create.title")).toBeInTheDocument();
    expect(screen.getByText("memory.create.description")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderSheet({ open: false });

    expect(screen.queryByText("memory.create.title")).not.toBeInTheDocument();
  });

  it("renders the content textarea", () => {
    renderSheet();

    expect(screen.getByText("memory.table.content")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("memory.create.contentPlaceholder"),
    ).toBeInTheDocument();
  });

  it("renders category and importance labels", () => {
    renderSheet();

    expect(screen.getByText("memory.create.category")).toBeInTheDocument();
    expect(screen.getByText("memory.create.importance")).toBeInTheDocument();
  });

  it("opens in the list drawer, with Cancel and Create in its footer", () => {
    renderSheet();

    const footer = screen.getByRole("dialog").querySelector("[data-slot=sheet-footer]") as HTMLElement;
    expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "common.cancel",
      "memory.create.button",
    ]);
  });

  it("starts from empty fields each time it opens", async () => {
    const user = userEvent.setup();
    const { defaults, rerender } = renderSheet({ defaultInstanceId: "bot-alpha" });
    await user.type(screen.getByPlaceholderText("memory.create.contentPlaceholder"), "Half typed");

    rerender(<CreateMemorySheet {...defaults} defaultInstanceId="bot-alpha" open={false} />);
    rerender(<CreateMemorySheet {...defaults} defaultInstanceId="bot-alpha" open />);

    expect(await screen.findByPlaceholderText("memory.create.contentPlaceholder")).toHaveValue("");
  });

  it("disables create button when content is empty", () => {
    renderSheet();

    const createBtn = screen.getByRole("button", { name: "memory.create.button" });
    expect(createBtn).toBeDisabled();
  });

  it("calls api.memories.create with correct data on submit", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    createMock.mockResolvedValueOnce({ memory: { id: "m1", content: "fact", event: "created" } });

    renderSheet({ defaultInstanceId: "bot-alpha", onCreated, onOpenChange });

    const textarea = screen.getByPlaceholderText("memory.create.contentPlaceholder");
    await user.type(textarea, "User likes coffee");

    const createBtn = screen.getByRole("button", { name: "memory.create.button" });
    expect(createBtn).toBeEnabled();

    await user.click(createBtn);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith({
        instanceId: "bot-alpha",
        content: "User likes coffee",
        category: "general",
        importance: 5,
      });
    });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("shows error toast on failure", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    createMock.mockRejectedValueOnce(new Error("fail"));

    renderSheet({ defaultInstanceId: "bot-alpha" });

    await user.type(
      screen.getByPlaceholderText("memory.create.contentPlaceholder"),
      "some content",
    );
    await user.click(screen.getByRole("button", { name: "memory.create.button" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("memory.create.error");
    });
  });

  it("calls onOpenChange(false) when cancel is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderSheet({ onOpenChange });

    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
