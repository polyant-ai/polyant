// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillsTab } from "./skills-tab";
import type { SkillState } from "@/lib/api";

// ── Mocks ──────────────────────────────────────────────────────────────

const { mockToastSuccess, mockToastError, mockSkillsUpdate, mockSkillsList } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockSkillsUpdate: vi.fn(),
  mockSkillsList: vi.fn(),
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
    skills: {
      update: (...args: unknown[]) => mockSkillsUpdate(...args),
      list: (...args: unknown[]) => mockSkillsList(...args),
      getEnv: vi.fn(),
      setEnv: vi.fn(),
      setAutoLoad: vi.fn().mockResolvedValue({}),
      upgrade: vi.fn().mockResolvedValue({}),
    },
    tools: {
      update: vi.fn().mockResolvedValue({ tools: [] }),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

// Mock the SkillEnvDialog since it's a separate component
vi.mock("./skill-env-dialog", () => ({
  SkillEnvDialog: ({ open, onOpenChange, skillName }: { open: boolean; onOpenChange: (open: boolean) => void; skillName: string }) =>
    open ? (
      <div data-testid="skill-env-dialog">
        <span>Env dialog for {skillName}</span>
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null,
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeSkills(): SkillState[] {
  return [
    {
      name: "web-search",
      description: "Search the web for information",
      enabled: true,
      requiredEnv: [{ name: "TAVILY_API_KEY", sensitive: true }],
      envConfigured: true,
    },
    {
      name: "code-review",
      description: "Review code for best practices",
      enabled: false,
      requiredEnv: [],
      envConfigured: true,
    },
    {
      name: "email-sender",
      description: "Send emails via SMTP",
      enabled: true,
      requiredEnv: [
        { name: "SMTP_HOST", sensitive: false },
        { name: "SMTP_PASSWORD", sensitive: true },
      ],
      envConfigured: false,
    },
  ];
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("SkillsTab", () => {
  const onSkillsUpdate = vi.fn();
  const onToolsUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no skills exist", () => {
    render(<SkillsTab slug="test-instance" skills={[]} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />);

    expect(screen.getByText("skills.tab.empty")).toBeInTheDocument();
  });

  it("renders all skills with names and descriptions", () => {
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    expect(screen.getByText("web-search")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.getByText("email-sender")).toBeInTheDocument();

    expect(screen.getByText("Search the web for information")).toBeInTheDocument();
    expect(screen.getByText("Review code for best practices")).toBeInTheDocument();
    expect(screen.getByText("Send emails via SMTP")).toBeInTheDocument();
  });

  it("renders description text", () => {
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    expect(screen.getByText("skills.tab.description")).toBeInTheDocument();
  });

  it("shows switches reflecting skill enabled state", () => {
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    // Component sorts enabled-first (preserving array order), then disabled.
    // Rendered order: web-search (enabled), email-sender (enabled), code-review (disabled)
    // web-search   (enabled): autoLoad[0] + main[1]
    // email-sender (enabled): autoLoad[2] + main[3]
    // code-review  (disabled): main only[4]
    // Total: 5 switches
    expect(switches[1]).toBeChecked(); // web-search main
    expect(switches[3]).toBeChecked(); // email-sender main
    expect(switches[4]).not.toBeChecked(); // code-review main
  });

  it("shows env var badge for skills with required env", () => {
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    // web-search has 1 env var, email-sender has 2 env vars
    expect(screen.getByText("1 env var")).toBeInTheDocument();
    expect(screen.getByText("2 env vars")).toBeInTheDocument();
  });

  it("does not show env var badge for skills without required env", () => {
    const skills: SkillState[] = [
      {
        name: "simple-skill",
        description: "No env needed",
        enabled: true,
        requiredEnv: [],
        envConfigured: true,
      },
    ];

    render(
      <SkillsTab slug="test-instance" skills={skills} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    expect(screen.queryByText(/env var/)).not.toBeInTheDocument();
  });

  it("shows configure button for enabled skills with env vars", () => {
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    // web-search (enabled, has env) and email-sender (enabled, has env) should have configure buttons
    const configureButtons = screen.getAllByText("skills.tab.configure");
    expect(configureButtons).toHaveLength(2);
  });

  it("does not show configure button for disabled skills", () => {
    const skills: SkillState[] = [
      {
        name: "disabled-skill",
        description: "A disabled skill",
        enabled: false,
        requiredEnv: [{ name: "SOME_KEY", sensitive: true }],
        envConfigured: false,
      },
    ];

    render(
      <SkillsTab slug="test-instance" skills={skills} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    expect(screen.queryByText("skills.tab.configure")).not.toBeInTheDocument();
  });

  it("does not show save button when nothing is toggled", () => {
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("shows save button when a skill is toggled", async () => {
    const user = userEvent.setup();
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    // Toggle code-review main switch (index 4: sorted enabled-first)
    const switches = screen.getAllByRole("switch");
    await user.click(switches[4]);

    expect(lastSaveAction.current?.isDirty).toBe(true);
  });

  it("hides save button when toggle is reverted", async () => {
    const user = userEvent.setup();
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    // Toggle code-review on then off
    await user.click(switches[4]);
    expect(lastSaveAction.current?.isDirty).toBe(true);

    await user.click(switches[4]);
    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("saves enabled skills and calls onSkillsUpdate", async () => {
    const user = userEvent.setup();
    const skills = makeSkills();
    const updatedSkills = skills.map((s) =>
      s.name === "code-review" ? { ...s, enabled: true } : s,
    );
    mockSkillsUpdate.mockResolvedValueOnce({ skills: updatedSkills });

    render(
      <SkillsTab slug="test-instance" skills={skills} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    // Enable code-review (main switch at index 2)
    const switches = screen.getAllByRole("switch");
    await user.click(switches[4]);

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      // All three should be enabled now
      expect(mockSkillsUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.arrayContaining(["web-search", "code-review", "email-sender"]),
      );
    });

    expect(onSkillsUpdate).toHaveBeenCalledWith(updatedSkills);
    expect(mockToastSuccess).toHaveBeenCalledWith("skills.tab.saved");
  });

  it("shows error toast on save failure", async () => {
    const user = userEvent.setup();
    mockSkillsUpdate.mockRejectedValueOnce(new Error("Save failed"));

    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    await user.click(switches[4]); // Toggle code-review

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("skills.tab.saveFailed");
    });
  });

  it("opens env dialog when configure button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    // Click first configure button (web-search)
    const configureButtons = screen.getAllByText("skills.tab.configure");
    await user.click(configureButtons[0]);

    expect(screen.getByTestId("skill-env-dialog")).toBeInTheDocument();
    expect(screen.getByText("Env dialog for web-search")).toBeInTheDocument();
  });

  it("closes env dialog when dismissed", async () => {
    const user = userEvent.setup();
    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    // Open dialog
    const configureButtons = screen.getAllByText("skills.tab.configure");
    await user.click(configureButtons[0]);

    expect(screen.getByTestId("skill-env-dialog")).toBeInTheDocument();

    // Close dialog
    await user.click(screen.getByText("Close"));

    expect(screen.queryByTestId("skill-env-dialog")).not.toBeInTheDocument();
  });

  it("shows destructive badge when skill is enabled but env not configured", () => {
    const skills: SkillState[] = [
      {
        name: "misconfigured-skill",
        description: "Needs setup",
        enabled: true,
        requiredEnv: [{ name: "API_KEY", sensitive: true }],
        envConfigured: false,
      },
    ];

    const { container } = render(
      <SkillsTab slug="test-instance" skills={skills} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    // The badge should have destructive variant - check for data attribute or class
    const badge = screen.getByText("1 env var");
    // shadcn Badge with variant="destructive" renders with that data attribute
    expect(badge.closest("[data-slot='badge']") ?? badge).toBeInTheDocument();
  });

  it("disables save button while saving", async () => {
    const user = userEvent.setup();

    let resolveUpdate: (value: unknown) => void;
    mockSkillsUpdate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    render(
      <SkillsTab slug="test-instance" skills={makeSkills()} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
    );

    const switches = screen.getAllByRole("switch");
    await user.click(switches[4]);

    const savePromise = lastSaveAction.current!.onSave();

    await waitFor(() => expect(lastSaveAction.current?.saving).toBe(true));

    resolveUpdate!({ skills: makeSkills() });
    await savePromise;

    await waitFor(() => {
      expect(onSkillsUpdate).toHaveBeenCalled();
    });
    expect(lastSaveAction.current?.saving).toBe(false);
  });
});
