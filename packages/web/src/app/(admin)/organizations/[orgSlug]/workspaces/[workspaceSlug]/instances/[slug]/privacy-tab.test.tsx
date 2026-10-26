// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
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

    // The manual opt-out lives in a drawer; Radix SelectTrigger exposes role="combobox".
    await userEvent.click(screen.getByRole("button", { name: "privacy.add" }));
    expect(within(await screen.findByRole("dialog")).getByRole("combobox")).toBeInTheDocument();
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
    const onUpdate = vi.fn();
    const updated = makeInstance({ optoutEnabled: true });
    mockInstanceUpdate.mockResolvedValue({ instance: updated });
    render(<PrivacyTab instance={makeInstance({ optoutEnabled: false })} onUpdate={onUpdate} />);

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
    expect(onUpdate).toHaveBeenCalledWith(updated);
    expect(mockToastSuccess).toHaveBeenCalledWith("privacy.saved");
  });

  it("opts out a contact using whatsapp as the default channel", async () => {
    const user = userEvent.setup();
    render(<PrivacyTab instance={makeInstance()} />);

    await waitFor(() => {
      expect(mockOptoutsList).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: "privacy.add" }));
    // The contact id input placeholder reflects the default channel (whatsapp).
    await user.type(screen.getByPlaceholderText("+39123456789"), "+39123456789");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "common.add" }));

    await waitFor(() => {
      expect(mockOptoutsOptOut).toHaveBeenCalledWith(
        "test-instance",
        "whatsapp",
        "+39123456789",
      );
    });
  });

  it("re-enables a contact from its drawer, not from the row", async () => {
    const user = userEvent.setup();
    mockOptoutsList.mockResolvedValue({
      optouts: [
        { channelType: "whatsapp", channelId: "+39222", source: "keyword", updatedAt: "2026-10-01T00:00:00Z" },
        { channelType: "slack", channelId: "+39111", source: "manual", updatedAt: "2026-10-02T00:00:00Z" },
      ],
    });
    render(<PrivacyTab instance={makeInstance()} />);
    await screen.findByText("+39222");
    expect(screen.queryByRole("button", { name: "privacy.reEnable" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+39222" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "privacy.reEnable" }));

    await waitFor(() => expect(mockOptoutsOptIn).toHaveBeenCalledWith("test-instance", "whatsapp", "+39222"));
  });

  it("lists contacts by their id and finds one by channel or source", async () => {
    const user = userEvent.setup();
    mockOptoutsList.mockResolvedValue({
      optouts: [
        { channelType: "whatsapp", channelId: "+39222", source: "keyword", updatedAt: null },
        { channelType: "slack", channelId: "+39111", source: "manual", updatedAt: null },
      ],
    });
    render(<PrivacyTab instance={makeInstance()} />);
    await screen.findByText("+39222");

    const ids = screen.getAllByRole("button", { name: /\+39/ }).map((b) => b.textContent);
    expect(ids).toEqual(["+39111", "+39222"]);

    await user.type(screen.getByRole("searchbox"), "manual");

    expect(screen.queryByText("+39222")).not.toBeInTheDocument();
    expect(screen.getByText("+39111")).toBeInTheDocument();
  });

  it("puts Re-enable among the right-hand actions, before Close, and describes the contact in one line", async () => {
    const user = userEvent.setup();
    mockOptoutsList.mockResolvedValue({
      optouts: [{ channelType: "whatsapp", channelId: "+39222", source: "keyword", updatedAt: null }],
    });
    render(<PrivacyTab instance={makeInstance()} />);
    await user.click(await screen.findByRole("button", { name: "+39222" }));
    const drawer = await screen.findByRole("dialog");

    const reEnable = within(drawer).getByRole("button", { name: "privacy.reEnable" });
    // The footer's Close shares its group with the extras (the sheet's corner X is elsewhere).
    const close = within(reEnable.parentElement!).getByRole("button", { name: "common.close" });
    expect(reEnable.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(drawer).getByText("whatsapp · keyword")).toBeInTheDocument();
  });

  it("lets the contacts list use the full width and does not repeat the section title in its card", async () => {
    const { container } = render(<PrivacyTab instance={makeInstance()} />);
    await waitFor(() => expect(mockOptoutsList).toHaveBeenCalled());
    expect(screen.queryByText("privacy.title")).not.toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass("max-w-2xl");
  });
});
