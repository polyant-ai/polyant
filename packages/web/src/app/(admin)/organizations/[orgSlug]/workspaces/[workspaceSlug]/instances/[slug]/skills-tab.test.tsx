// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders, userEvent } from "@/test-utils";
import { SkillsTab } from "./skills-tab";
import type { SkillState } from "@/lib/api";

// ── Mocks ──────────────────────────────────────────────────────────────

const { mockToastSuccess, mockToastError, mockSkillsUpdate, mockSkillsList, mockSetAutoLoad, mockUpgrade, mockToolsUpdate } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockSkillsUpdate: vi.fn(),
  mockSkillsList: vi.fn(),
  mockSetAutoLoad: vi.fn(),
  mockUpgrade: vi.fn(),
  mockToolsUpdate: vi.fn(),
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
    info: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    skills: {
      update: (...args: unknown[]) => mockSkillsUpdate(...args),
      list: (...args: unknown[]) => mockSkillsList(...args),
      getEnv: vi.fn().mockResolvedValue({ env: [] }),
      setEnv: vi.fn(),
      setAutoLoad: (...args: unknown[]) => mockSetAutoLoad(...args),
      upgrade: (...args: unknown[]) => mockUpgrade(...args),
    },
    tools: {
      update: (...args: unknown[]) => mockToolsUpdate(...args),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

// The environment panel reads and writes its own endpoints and has its own tests.
vi.mock("./skill-env-panel", () => ({
  SkillEnvPanel: ({ skillName }: { skillName: string }) => <div data-testid="skill-env-panel">Env panel for {skillName}</div>,
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeSkills(): SkillState[] {
  return [
    {
      name: "web-search",
      description: "Search the web for information",
      category: "research",
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

const onSkillsUpdate = vi.fn();
const onToolsUpdate = vi.fn();

function renderTab(skills: SkillState[] = makeSkills()) {
  return renderWithProviders(
    <SkillsTab slug="test-instance" skills={skills} tools={[]} onSkillsUpdate={onSkillsUpdate} onToolsUpdate={onToolsUpdate} />,
  );
}

const rowOf = (name: string) => screen.getByRole("button", { name }).closest("tr") as HTMLElement;
const switchOf = (name: string) => screen.getByRole("switch", { name: `Attivo: ${name}` });

// ── Tests ──────────────────────────────────────────────────────────────

describe("SkillsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the empty state when no skills exist", () => {
    renderTab([]);
    expect(screen.getByText(/Nessuna skill disponibile/)).toBeInTheDocument();
  });

  it("lists every skill with its description under the name, in a table", () => {
    renderTab();
    for (const name of ["web-search", "code-review", "email-sender"]) {
      expect(within(rowOf(name)).getByText(name)).toBeInTheDocument();
    }
    expect(within(rowOf("web-search")).getByText("Search the web for information")).toBeInTheDocument();
    expect(within(rowOf("web-search")).getByText("research")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Nome", "Categoria", "Attivo"]);
  });

  // A long description used to push every row to a different height; clamped, the
  // list stays scannable and the full text is still one hover away.
  it("clamps a skill's description to two lines with the full text on hover, and omits an empty one", () => {
    const long = "Search the web for information ".repeat(20).trim();
    renderTab([
      { name: "long-one", description: long, enabled: true, requiredEnv: [], envConfigured: true },
      { name: "no-description", description: "", enabled: true, requiredEnv: [], envConfigured: true },
    ]);
    const description = screen.getByText(long);
    expect(description).toHaveClass("line-clamp-2");
    expect(description).toHaveAttribute("title", long);
    expect(document.querySelectorAll("[title]")).toHaveLength(1);
  });

  it("filters the list on the name, the description and the category as typed", async () => {
    const user = userEvent.setup();
    renderTab();
    const search = screen.getByRole("searchbox", { name: "Cerca" });

    await user.type(search, "smtp");
    expect(screen.getByText("email-sender")).toBeInTheDocument();
    expect(screen.queryByText("web-search")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "research");
    expect(screen.getByText("web-search")).toBeInTheDocument();
    expect(screen.queryByText("email-sender")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("Nessun risultato")).toBeInTheDocument();
  });

  // Enabled-first made a row jump to the top the moment its switch was flicked.
  it("lists the skills alphabetically and keeps a row in place when it is switched on", async () => {
    const user = userEvent.setup();
    renderTab();
    const order = () => screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("button")[0].textContent);
    expect(order()).toEqual(["code-review", "email-sender", "web-search"]);
    await user.click(switchOf("code-review"));
    expect(order()).toEqual(["code-review", "email-sender", "web-search"]);
  });

  it("ends the drawer with Upgrade, then Close, and describes the skill in one line", async () => {
    const user = userEvent.setup();
    renderTab([
      { name: "pinned", description: "Old", enabled: true, requiredEnv: [], envConfigured: true, pinnedVersion: "1", hasUpdate: true },
      { name: "plain", description: "", enabled: true, requiredEnv: [], envConfigured: true },
    ]);
    await user.click(screen.getByRole("button", { name: "pinned" }));
    let drawer = await screen.findByRole("dialog");
    const footer = drawer.querySelector("[data-slot=sheet-footer]") as HTMLElement;
    expect(within(footer).getAllByRole("button").map((b) => b.textContent)).toEqual(["Aggiorna", "Chiudi"]);
    expect(drawer.querySelector("[data-slot=sheet-description]")).toHaveTextContent("Old");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // A skill without a description still has its line.
    await user.click(screen.getByRole("button", { name: "plain" }));
    drawer = await screen.findByRole("dialog");
    expect(drawer.querySelector("[data-slot=sheet-description]")).toHaveTextContent("Nessuna descrizione");
  });

  it("shows one switch per row, in the last column, reflecting whether the skill is enabled", () => {
    renderTab();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(switchOf("web-search")).toBeChecked();
    expect(switchOf("email-sender")).toBeChecked();
    expect(switchOf("code-review")).not.toBeChecked();
    const cells = within(rowOf("web-search")).getAllByRole("cell");
    expect(within(cells[cells.length - 1]).getByRole("switch")).toBe(switchOf("web-search"));
  });

  it("shows the env var badge only for skills with required env", () => {
    renderTab();
    expect(screen.getByText("1 env var")).toBeInTheDocument();
    expect(screen.getByText("2 env vars")).toBeInTheDocument();
    expect(screen.getAllByText(/env var/)).toHaveLength(2);
  });

  it("does not show the save button when nothing is toggled", () => {
    renderTab();
    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("marks the page dirty when a skill is toggled and clean again when it is reverted", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(switchOf("code-review"));
    expect(lastSaveAction.current?.isDirty).toBe(true);
    await user.click(switchOf("code-review"));
    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("toggling the switch never opens the drawer", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(switchOf("code-review"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the skill's drawer from anywhere on its row", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(within(rowOf("web-search")).getByText("Search the web for information"));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "web-search" })).toBeInTheDocument();
  });

  it("keeps the per-skill controls in the drawer, not on the row", async () => {
    const user = userEvent.setup();
    renderTab();
    // Only the Active switches are on the list: no auto-load switch, configure or upgrade button per row.
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Configura/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "web-search" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("switch", { name: /Caricamento automatico/ })).toBeInTheDocument();
    expect(within(drawer).getByTestId("skill-env-panel")).toHaveTextContent("Env panel for web-search");
  });

  it("offers the environment panel only for an enabled skill that declares variables", async () => {
    const user = userEvent.setup();
    renderTab([
      { name: "disabled-skill", description: "A disabled skill", enabled: false, requiredEnv: [{ name: "SOME_KEY", sensitive: true }], envConfigured: false },
    ]);
    await user.click(screen.getByRole("button", { name: "disabled-skill" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).queryByTestId("skill-env-panel")).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("switch")).not.toBeInTheDocument();
  });

  it("saves the auto-load switch of the drawer at once and reports it", async () => {
    const user = userEvent.setup();
    mockSetAutoLoad.mockResolvedValue({});
    renderTab();
    await user.click(screen.getByRole("button", { name: "web-search" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("switch", { name: /Caricamento automatico/ }));
    await waitFor(() => expect(mockSetAutoLoad).toHaveBeenCalledWith("test-instance", "web-search", true));
    expect(onSkillsUpdate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: "web-search", autoLoad: true })]));
    expect(mockToastSuccess).toHaveBeenCalledWith("Caricamento automatico attivato");
  });

  it("upgrades a skill from its drawer when a newer version exists", async () => {
    const user = userEvent.setup();
    mockUpgrade.mockResolvedValue({});
    mockSkillsList.mockResolvedValue({ skills: makeSkills() });
    renderTab([{ name: "pinned", description: "Old", enabled: true, requiredEnv: [], envConfigured: true, pinnedVersion: "1", hasUpdate: true }]);
    await user.click(screen.getByRole("button", { name: "pinned" }));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Aggiorna" }));
    await waitFor(() => expect(mockUpgrade).toHaveBeenCalledWith("test-instance", "pinned"));
    expect(mockToastSuccess).toHaveBeenCalledWith("Skill aggiornata con successo");
  });

  it("saves enabled skills with the page's save and calls onSkillsUpdate", async () => {
    const user = userEvent.setup();
    const skills = makeSkills();
    const updatedSkills = skills.map((s) => (s.name === "code-review" ? { ...s, enabled: true } : s));
    mockSkillsUpdate.mockResolvedValueOnce({ skills: updatedSkills });
    renderTab(skills);

    await user.click(switchOf("code-review"));
    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockSkillsUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.arrayContaining(["web-search", "code-review", "email-sender"]),
      );
    });
    expect(onSkillsUpdate).toHaveBeenCalledWith(updatedSkills);
    expect(mockToastSuccess).toHaveBeenCalledWith("Skill aggiornate");
  });

  it("shows an error toast on save failure", async () => {
    const user = userEvent.setup();
    mockSkillsUpdate.mockRejectedValueOnce(new Error("Save failed"));
    renderTab();
    await user.click(switchOf("code-review"));
    await lastSaveAction.current!.onSave();
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Salvataggio fallito"));
  });

  it("enabling a skill also drafts its required tools on", async () => {
    const user = userEvent.setup();
    mockSkillsUpdate.mockResolvedValue({ skills: [] });
    mockToolsUpdate.mockResolvedValue({ tools: [] });
    renderWithProviders(
      <SkillsTab
        slug="test-instance"
        skills={[{ name: "needs-tool", description: "", enabled: false, requiredTools: ["fetch"], requiredEnv: [], envConfigured: true }]}
        tools={[{ name: "fetch", enabled: false } as never]}
        onSkillsUpdate={onSkillsUpdate}
        onToolsUpdate={onToolsUpdate}
      />,
    );
    await user.click(switchOf("needs-tool"));
    await lastSaveAction.current!.onSave();
    await waitFor(() => expect(mockToolsUpdate).toHaveBeenCalledWith("test-instance", ["fetch"]));
  });

  it("disables the save while saving", async () => {
    const user = userEvent.setup();
    let resolveUpdate: (value: unknown) => void;
    mockSkillsUpdate.mockReturnValueOnce(new Promise((resolve) => { resolveUpdate = resolve; }));
    renderTab();
    await user.click(switchOf("code-review"));
    const savePromise = lastSaveAction.current!.onSave();
    await waitFor(() => expect(lastSaveAction.current?.saving).toBe(true));
    resolveUpdate!({ skills: makeSkills() });
    await savePromise;
    await waitFor(() => expect(lastSaveAction.current?.saving).toBe(false));
    expect(onSkillsUpdate).toHaveBeenCalled();
  });
});
