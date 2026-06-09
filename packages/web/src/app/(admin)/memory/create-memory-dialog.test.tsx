// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateMemoryDialog } from "./create-memory-dialog";
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
    memoryEnabled: true,
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
  },
  {
    id: "inst-2",
    slug: "bot-beta",
    name: "Bot Beta",
    description: null,
    status: "active",
    provider: null,
    model: null,
    memoryEnabled: true,
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
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

function renderDialog(
  props: Partial<React.ComponentProps<typeof CreateMemoryDialog>> = {},
) {
  const defaults = {
    open: true,
    onOpenChange: vi.fn(),
    instances,
    onCreated: vi.fn(),
  };
  return { ...render(<CreateMemoryDialog {...defaults} {...props} />), defaults };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("CreateMemoryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders dialog title and description when open", () => {
    renderDialog();

    expect(screen.getByText("memory.create.title")).toBeInTheDocument();
    expect(screen.getByText("memory.create.description")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderDialog({ open: false });

    expect(screen.queryByText("memory.create.title")).not.toBeInTheDocument();
  });

  it("renders the content textarea", () => {
    renderDialog();

    expect(screen.getByText("memory.table.content")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("memory.create.contentPlaceholder"),
    ).toBeInTheDocument();
  });

  it("renders category and importance labels", () => {
    renderDialog();

    expect(screen.getByText("memory.create.category")).toBeInTheDocument();
    expect(screen.getByText("memory.create.importance")).toBeInTheDocument();
  });

  it("renders cancel and create buttons", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "common.cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "memory.create.button" })).toBeInTheDocument();
  });

  it("disables create button when content is empty", () => {
    renderDialog();

    const createBtn = screen.getByRole("button", { name: "memory.create.button" });
    expect(createBtn).toBeDisabled();
  });

  it("calls api.memories.create with correct data on submit", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    createMock.mockResolvedValueOnce({ memory: { id: "m1", content: "fact", event: "created" } });

    renderDialog({ defaultInstanceId: "bot-alpha", onCreated, onOpenChange });

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

    renderDialog({ defaultInstanceId: "bot-alpha" });

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

    renderDialog({ onOpenChange });

    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
