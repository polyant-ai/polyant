// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GeneralTab } from "./general-tab";
import type { Instance } from "@/lib/api";

// ── Mocks ──────────────────────────────────────────────────────────────

const { mockUpdate, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock the page-actions context: the tab uses usePageSaveAction to register
// its save callback with the top-bar Save button. In tests we capture the
// most recent registration so the assertions can read isDirty/saving and
// invoke onSave directly without rendering the top bar.
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
    instances: {
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "test-instance",
    name: "Test Instance",
    description: "A test instance",
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
    sttProvider: "openai",
    icon: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("GeneralTab", () => {
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all form fields with instance values", () => {
    const instance = makeInstance();
    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    // Name field
    expect(screen.getByLabelText("general.name")).toHaveValue("Test Instance");

    // Slug field (disabled)
    const slugInput = screen.getByLabelText("general.slug");
    expect(slugInput).toHaveValue("test-instance");
    expect(slugInput).toBeDisabled();

    // Description field
    expect(screen.getByLabelText("general.description")).toHaveValue("A test instance");

    // Status label
    expect(screen.getByText("general.status")).toBeInTheDocument();
  });

  it("renders with empty description when instance.description is null", () => {
    const instance = makeInstance({ description: null });
    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    expect(screen.getByLabelText("general.description")).toHaveValue("");
  });

  it("registers save action as non-dirty when form has not changed", () => {
    const instance = makeInstance();
    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("registers save action as dirty when name is changed", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const nameInput = screen.getByLabelText("general.name");
    await user.clear(nameInput);
    await user.type(nameInput, "New Name");

    expect(lastSaveAction.current?.isDirty).toBe(true);
  });

  it("registers save action as dirty when description is changed", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const descInput = screen.getByLabelText("general.description");
    await user.clear(descInput);
    await user.type(descInput, "New description");

    expect(lastSaveAction.current?.isDirty).toBe(true);
  });

  it("registers save action as dirty when status is toggled", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ status: "active" });
    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const toggle = screen.getByRole("switch");
    await user.click(toggle);

    expect(lastSaveAction.current?.isDirty).toBe(true);
  });

  it("saves successfully and calls onUpdate", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    const updatedInstance = makeInstance({ name: "Updated Name" });
    mockUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const nameInput = screen.getByLabelText("general.name");
    await user.clear(nameInput);
    await user.type(nameInput, "Updated Name");

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("test-instance", {
        name: "Updated Name",
        description: "A test instance",
        status: "active",
      });
    });

    expect(onUpdate).toHaveBeenCalledWith(updatedInstance);
    expect(mockToastSuccess).toHaveBeenCalledWith("general.saved");
  });

  it("sends null description when description is cleared", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ description: "Old desc" });
    const updatedInstance = makeInstance({ description: null });
    mockUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const descInput = screen.getByLabelText("general.description");
    await user.clear(descInput);

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("test-instance", expect.objectContaining({
        description: null,
      }));
    });
  });

  it("shows error toast on save failure", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    mockUpdate.mockRejectedValueOnce(new Error("Network error"));

    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const nameInput = screen.getByLabelText("general.name");
    await user.clear(nameInput);
    await user.type(nameInput, "Changed Name");

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("general.saveFailed");
    });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("registers saving=true while save is in flight, then false on resolution", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();

    let resolveUpdate: (value: unknown) => void;
    mockUpdate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    render(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const nameInput = screen.getByLabelText("general.name");
    await user.clear(nameInput);
    await user.type(nameInput, "New");

    const savePromise = lastSaveAction.current!.onSave();

    await waitFor(() => expect(lastSaveAction.current?.saving).toBe(true));

    resolveUpdate!({ instance: makeInstance({ name: "New" }) });
    await savePromise;

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(lastSaveAction.current?.saving).toBe(false);
  });
});
