// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { GeneralTab } from "./general-tab";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
import type { Instance } from "@/lib/api";

function SaveButton() {
  const { saveAction } = usePageActions();
  if (!saveAction?.isDirty) return null;
  return (
    <button
      onClick={() => saveAction.onSave()}
      disabled={saveAction.saving}
    >
      {saveAction.saving ? "common.saving" : "common.save"}
    </button>
  );
}

function renderWithProvider(ui: ReactElement) {
  return render(
    <PageActionsProvider>
      {ui}
      <SaveButton />
    </PageActionsProvider>,
  );
}

// ── Mocks ──────────────────────────────────────────────────────────────

const {
  mockUpdate,
  mockToastSuccess,
  mockToastError,
  mockSecretsList,
  mockSecretsSet,
  mockSecretsDelete,
  mockOrgSecretsList,
} = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  // Untyped `vi.fn()` and resolved in `beforeEach`: an inline zero-arg
  // implementation makes the spread wrapper below a type error.
  mockSecretsList: vi.fn(),
  mockSecretsSet: vi.fn(),
  mockSecretsDelete: vi.fn(),
  mockOrgSecretsList: vi.fn(),
}));

// LangSmith moved into this tab, and its key comes through `useInstanceSecret` —
// which reads the agent's secrets and its organization's to tell "configured"
// from "inherited". Hence the two extra readers here.
vi.mock("@/lib/tenant/use-org-slug", () => ({ useOrgSlug: () => "acme" }));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
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
    secrets: {
      list: (...args: unknown[]) => mockSecretsList(...args),
      set: (...args: unknown[]) => mockSecretsSet(...args),
      delete: (...args: unknown[]) => mockSecretsDelete(...args),
    },
    organizationSecrets: { list: (...args: unknown[]) => mockOrgSecretsList(...args) },
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
    datetimeInjectionEnabled: true,
    cacheEnabled: true,
    cacheTtl: "1h",
    a2aEnabled: false,
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
    mockSecretsList.mockResolvedValue({ secrets: [] });
    mockSecretsSet.mockResolvedValue({ secrets: [] });
    mockSecretsDelete.mockResolvedValue({});
    mockOrgSecretsList.mockResolvedValue({ secrets: [] });
  });

  it("renders all form fields with instance values", () => {
    const instance = makeInstance();
    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

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
    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    expect(screen.getByLabelText("general.description")).toHaveValue("");
  });

  it("does not show save button when form is not dirty", () => {
    const instance = makeInstance();
    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    expect(screen.queryByText("common.save")).not.toBeInTheDocument();
  });

  it("shows save button when name is changed", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const nameInput = screen.getByLabelText("general.name");
    await user.clear(nameInput);
    await user.type(nameInput, "New Name");

    expect(screen.getByText("common.save")).toBeInTheDocument();
  });

  it("shows save button when description is changed", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const descInput = screen.getByLabelText("general.description");
    await user.clear(descInput);
    await user.type(descInput, "New description");

    expect(screen.getByText("common.save")).toBeInTheDocument();
  });

  it("shows save button when status is toggled", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ status: "active" });
    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    // Toggle the switch (active -> inactive)
    // Named, not positional: this tab holds two switches now (status and memory),
    // and `getByRole("switch")` cannot tell them apart — which is also why both
    // carry a label a screen reader can use.
    const toggle = screen.getByLabelText("general.status");
    await user.click(toggle);

    expect(screen.getByText("common.save")).toBeInTheDocument();
  });

  it("saves successfully and calls onUpdate", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    const updatedInstance = makeInstance({ name: "Updated Name" });
    mockUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const nameInput = screen.getByLabelText("general.name");
    await user.clear(nameInput);
    await user.type(nameInput, "Updated Name");

    const saveBtn = screen.getByText("common.save");
    await user.click(saveBtn);

    await waitFor(() => {
      // Identity only. Memory and LangSmith both left for Parametri, and this
      // payload is where a regression that dragged one back would show.
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

    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const descInput = screen.getByLabelText("general.description");
    await user.clear(descInput);

    const saveBtn = screen.getByText("common.save");
    await user.click(saveBtn);

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

    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const nameInput = screen.getByLabelText("general.name");
    await user.clear(nameInput);
    await user.type(nameInput, "Changed Name");

    const saveBtn = screen.getByText("common.save");
    await user.click(saveBtn);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("general.saveFailed");
    });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("disables save button while saving", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();

    let resolveUpdate: (value: unknown) => void;
    mockUpdate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    renderWithProvider(<GeneralTab instance={instance} onUpdate={onUpdate} />);

    const nameInput = screen.getByLabelText("general.name");
    await user.clear(nameInput);
    await user.type(nameInput, "New");

    const saveBtn = screen.getByText("common.save");
    await user.click(saveBtn);

    // While saving, button should show "saving" text and be disabled
    await waitFor(() => {
      expect(screen.getByText("common.saving")).toBeDisabled();
    });

    // Resolve the update
    resolveUpdate!({ instance: makeInstance({ name: "New" }) });

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalled();
    });
  });
});

