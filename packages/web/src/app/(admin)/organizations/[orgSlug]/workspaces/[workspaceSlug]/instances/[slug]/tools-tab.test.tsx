// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolsTab } from "./tools-tab";
import type { ToolState, SkillState } from "@/lib/api";

// ── Mocks ──────────────────────────────────────────────────────────────

const { mockToastSuccess, mockToastError, mockToolsUpdate } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToolsUpdate: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const lastSaveAction = vi.hoisted(() => ({
  current: null as null | { isDirty: boolean; saving: boolean; onSave: () => void | Promise<void> },
}));
vi.mock("./page-actions-context", () => ({
  usePageSaveAction: (a: { isDirty: boolean; saving: boolean; onSave: () => void | Promise<void> }) => {
    lastSaveAction.current = a;
  },
  usePageActions: vi.fn(() => ({ saveAction: null, setSaveAction: vi.fn() })),
  PageActionsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    tools: { update: (...args: unknown[]) => mockToolsUpdate(...args) },
    skills: { update: vi.fn() },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeTools(): ToolState[] {
  return [
    { name: "read", description: "Read files", category: "filesystem", enabled: true },
    { name: "write", description: "Write files", category: "filesystem", enabled: true },
    { name: "curl", description: "HTTP requests", category: "network", enabled: false },
    { name: "memorize", description: "Save to memory", category: "memory", enabled: true },
  ];
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("ToolsTab", () => {
  const onToolsUpdate = vi.fn();
  const onSkillsUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all tools with their names and category groups", () => {
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("write")).toBeInTheDocument();
    expect(screen.getByText("curl")).toBeInTheDocument();
    expect(screen.getByText("memorize")).toBeInTheDocument();

    // Categories now render as collapsible section headers (capitalized)
    expect(screen.getByText("Filesystem")).toBeInTheDocument();
    expect(screen.getByText("Network")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
  });

  it("renders tool descriptions", () => {
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    expect(screen.getByText("Read files")).toBeInTheDocument();
    expect(screen.getByText("Write files")).toBeInTheDocument();
    expect(screen.getByText("HTTP requests")).toBeInTheDocument();
    expect(screen.getByText("Save to memory")).toBeInTheDocument();
  });

  it("renders description text", () => {
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    expect(screen.getByText("tools.description")).toBeInTheDocument();
  });

  it("shows switches matching the tool enabled state", () => {
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    // Grouped by category (alphabetical): filesystem (read, write), memory (memorize), network (curl)
    expect(switches[0]).toBeChecked(); // read
    expect(switches[1]).toBeChecked(); // write
    expect(switches[2]).toBeChecked(); // memorize
    expect(switches[3]).not.toBeChecked(); // curl
  });

  it("does not show save button when nothing is toggled", () => {
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("shows save button when a tool is toggled", async () => {
    const user = userEvent.setup();
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    // Toggle the "curl" switch (index 2) from off to on
    const switches = screen.getAllByRole("switch");
    await user.click(switches[3]);

    expect(lastSaveAction.current?.isDirty).toBe(true);
  });

  it("does not show save button when a toggle is reverted", async () => {
    const user = userEvent.setup();
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    // Toggle curl on then off
    await user.click(switches[3]);
    expect(lastSaveAction.current?.isDirty).toBe(true);

    await user.click(switches[3]);
    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("saves toggled tools and calls onUpdate", async () => {
    const user = userEvent.setup();
    const tools = makeTools();
    const updatedTools = tools.map((t) =>
      t.name === "curl" ? { ...t, enabled: true } : t,
    );
    mockToolsUpdate.mockResolvedValueOnce({ tools: updatedTools });

    render(
      <ToolsTab slug="test-instance" tools={tools} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    // Enable curl
    const switches = screen.getAllByRole("switch");
    await user.click(switches[3]);

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      // Should send enabled tool names: read, write, curl, memorize (all enabled after toggling curl on)
      expect(mockToolsUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.arrayContaining(["read", "write", "curl", "memorize"]),
      );
    });

    expect(onToolsUpdate).toHaveBeenCalledWith(updatedTools);
    expect(mockToastSuccess).toHaveBeenCalledWith("tools.saved");
  });

  it("shows error toast on save failure", async () => {
    const user = userEvent.setup();
    mockToolsUpdate.mockRejectedValueOnce(new Error("Network error"));

    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    await user.click(switches[3]); // Toggle curl

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("tools.saveFailed");
    });
  });

  it("disables memory tools when memoryEnabled is false", () => {
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={false} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    // When memoryEnabled=false, memory tools render a Lock icon instead of a switch
    // So we should have 3 switches (read, write, curl) not 4
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
  });

  it("shows memory disabled hint for memory tools when memoryEnabled is false", () => {
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={false} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    expect(screen.getByText("tools.memoryDisabledHint")).toBeInTheDocument();
    // The original description for the memory tool should not show
    expect(screen.queryByText("Save to memory")).not.toBeInTheDocument();
  });

  it("enables memory tools when memoryEnabled is true", () => {
    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    // All 4 tools get a switch; memorize (index 2 in grouped order) should be checked
    expect(switches).toHaveLength(4);
    expect(switches[2]).toBeChecked(); // memorize
  });

  it("disables save button while saving", async () => {
    const user = userEvent.setup();

    let resolveUpdate: (value: unknown) => void;
    mockToolsUpdate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    render(
      <ToolsTab slug="test-instance" tools={makeTools()} skills={[]} memoryEnabled={true} knowledgeEnabled={true} onToolsUpdate={onToolsUpdate} onSkillsUpdate={onSkillsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    await user.click(switches[3]); // Toggle curl

    const savePromise = lastSaveAction.current!.onSave();

    await waitFor(() => expect(lastSaveAction.current?.saving).toBe(true));

    resolveUpdate!({ tools: makeTools() });
    await savePromise;

    await waitFor(() => {
      expect(onToolsUpdate).toHaveBeenCalled();
    });
    expect(lastSaveAction.current?.saving).toBe(false);
  });
});
