// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrivacyTab } from "./privacy-tab";
import type { Instance } from "@/lib/api";

// ── Mocks ──────────────────────────────────────────────────────────────

const {
  mockToastSuccess,
  mockToastError,
  mockInstanceUpdate,
  mockOptoutsList,
  mockOptoutsOptOut,
  mockOptoutsOptIn,
} = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockInstanceUpdate: vi.fn(),
  mockOptoutsList: vi.fn(),
  mockOptoutsOptOut: vi.fn(),
  mockOptoutsOptIn: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Captures the latest top-bar save registration so assertions can read
// isDirty/saving and invoke onSave without rendering the page header.
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
    instances: { update: (...args: unknown[]) => mockInstanceUpdate(...args) },
    optouts: {
      list: (...args: unknown[]) => mockOptoutsList(...args),
      optOut: (...args: unknown[]) => mockOptoutsOptOut(...args),
      optIn: (...args: unknown[]) => mockOptoutsOptIn(...args),
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
  } as Instance;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("PrivacyTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSaveAction.current = null;
    mockOptoutsList.mockResolvedValue({ optouts: [] });
    mockOptoutsOptOut.mockResolvedValue({ ok: true });
    mockOptoutsOptIn.mockResolvedValue({ ok: true });
    mockInstanceUpdate.mockResolvedValue({ instance: makeInstance() });
  });

  it("loads opted-out contacts on mount", async () => {
    render(<PrivacyTab instance={makeInstance()} />);

    await waitFor(() => {
      expect(mockOptoutsList).toHaveBeenCalledWith("test-instance", { status: "opted_out" });
    });
  });

  it("renders a channel select instead of a free-text input", async () => {
    render(<PrivacyTab instance={makeInstance()} />);

    await waitFor(() => {
      expect(mockOptoutsList).toHaveBeenCalled();
    });

    // Radix SelectTrigger exposes role="combobox".
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("registers a header save action that is not dirty initially", async () => {
    render(<PrivacyTab instance={makeInstance()} />);

    await waitFor(() => {
      expect(mockOptoutsList).toHaveBeenCalled();
    });

    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("marks dirty when the enable toggle changes", async () => {
    const user = userEvent.setup();
    render(<PrivacyTab instance={makeInstance({ optoutEnabled: false })} />);

    await waitFor(() => {
      expect(mockOptoutsList).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("switch"));

    expect(lastSaveAction.current?.isDirty).toBe(true);
  });

  it("saves the opt-out config through the header save action", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<PrivacyTab instance={makeInstance({ optoutEnabled: false })} onSaved={onSaved} />);

    await waitFor(() => {
      expect(mockOptoutsList).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("switch"));
    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockInstanceUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.objectContaining({ optoutEnabled: true }),
      );
    });
    expect(onSaved).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("privacy.saved");
  });

  it("opts out a contact using whatsapp as the default channel", async () => {
    const user = userEvent.setup();
    render(<PrivacyTab instance={makeInstance()} />);

    await waitFor(() => {
      expect(mockOptoutsList).toHaveBeenCalled();
    });

    // The contact id input placeholder reflects the default channel (whatsapp).
    await user.type(screen.getByPlaceholderText("+39123456789"), "+39123456789");
    await user.click(screen.getByText("privacy.optOutContactButton"));

    await waitFor(() => {
      expect(mockOptoutsOptOut).toHaveBeenCalledWith(
        "test-instance",
        "whatsapp",
        "+39123456789",
      );
    });
  });
});
