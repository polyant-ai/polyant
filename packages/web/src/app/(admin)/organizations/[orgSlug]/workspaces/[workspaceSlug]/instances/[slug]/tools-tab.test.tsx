// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolsTab } from "./tools-tab";
import type { ToolState, SkillState } from "@/lib/api";

// ── Mocks ──────────────────────────────────────────────────────────────

const {
  mockToastSuccess,
  mockToastError,
  mockToolsUpdate,
  mockSkillsUpdate,
  mockSecretsList,
  mockSecretsSet,
  mockRequiredSecrets,
} = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToolsUpdate: vi.fn(),
  mockSkillsUpdate: vi.fn(),
  mockSecretsList: vi.fn(),
  mockSecretsSet: vi.fn(),
  mockRequiredSecrets: vi.fn(),
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
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const { Forbidden } = vi.hoisted(() => ({ Forbidden: class Forbidden extends Error {} }));

vi.mock("@/lib/api", () => ({
  api: {
    tools: {
      update: (...args: unknown[]) => mockToolsUpdate(...args),
      requiredSecrets: (...args: unknown[]) => mockRequiredSecrets(...args),
    },
    skills: { update: (...args: unknown[]) => mockSkillsUpdate(...args) },
    secrets: {
      list: (...args: unknown[]) => mockSecretsList(...args),
      set: (...args: unknown[]) => mockSecretsSet(...args),
      delete: vi.fn(),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
  isForbidden: (e: unknown) => e instanceof Forbidden,
}));

// ── Helpers ────────────────────────────────────────────────────────────

function makeTools(): ToolState[] {
  return [
    { name: "readFile", description: "Read files\nUsage rules for the model.", category: "files", enabled: true },
    { name: "curl", description: "HTTP requests", category: "network", enabled: false },
    { name: "saveMemory", description: "Save to memory", category: "memory", enabled: true },
    {
      name: "crm:contact",
      description: "Find contacts",
      category: "crm",
      enabled: true,
      requiredSecrets: [
        { key: "crm_api_key", type: "text", sensitive: true, label: "CRM API key", description: "The key of the CRM account." },
        { key: "crm_base_url", type: "text", sensitive: false, label: "CRM base URL" },
        { key: "openai_api_key", type: "text", sensitive: true, label: "OpenAI API Key" },
      ],
    },
    {
      name: "crm:deal",
      description: "Manage deals",
      category: "crm",
      enabled: false,
      requiredSecrets: [{ key: "crm_api_key", type: "text", sensitive: true, label: "CRM API key" }],
    },
    { name: "readSkill", description: "Read a skill", category: "skills", enabled: true, source: "global" },
  ];
}

function renderTab(overrides: Partial<React.ComponentProps<typeof ToolsTab>> = {}) {
  const props: React.ComponentProps<typeof ToolsTab> = {
    slug: "agent-1",
    tools: makeTools(),
    skills: [],
    memoryEnabled: true,
    knowledgeEnabled: true,
    onToolsUpdate: vi.fn(),
    onSkillsUpdate: vi.fn(),
    ...overrides,
  };
  return { ...render(<ToolsTab {...props} />), props };
}

const rowOf = (text: string) => screen.getByText(text).closest("tr") as HTMLElement;

async function disable(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(within(rowOf(text)).getByRole("button", { name: "tools.disableTool" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "tools.disable" }));
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("ToolsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSaveAction.current = null;
    mockSecretsList.mockResolvedValue({ secrets: [{ key: "crm_base_url", configured: true }] });
    mockRequiredSecrets.mockResolvedValue({
      requiredSecrets: [{ key: "crm_base_url", type: "text", sensitive: false, currentValue: "https://crm.example.com" }],
    });
    mockSecretsSet.mockResolvedValue({ secrets: [{ key: "crm_api_key", configured: true }] });
    mockToolsUpdate.mockResolvedValue({ tools: makeTools() });
  });

  it("lists the enabled tools only, with the first line of their description", () => {
    renderTab();

    expect(screen.getByText("readFile")).toBeInTheDocument();
    expect(screen.getByText("contact")).toBeInTheDocument();
    expect(screen.getByText("Read files")).toBeInTheDocument();
    expect(screen.queryByText("Usage rules for the model.")).not.toBeInTheDocument();
    // Disabled tools live in the picker, not in the table.
    expect(screen.queryByText("curl")).not.toBeInTheDocument();
    expect(screen.queryByText("deal")).not.toBeInTheDocument();
  });

  it("lists an always-enabled tool last, without a disable action", () => {
    renderTab();

    const row = rowOf("readSkill");
    expect(within(row).getByText("tools.alwaysEnabled")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "tools.disableTool" })).not.toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(rows[rows.length - 1]).toBe(row);
  });

  it("starts clean: nothing to save", () => {
    renderTab();
    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("enables tools from the picker as a draft, confirmed by Save", async () => {
    const user = userEvent.setup();
    const { props } = renderTab();

    await user.click(screen.getByRole("button", { name: "tools.enable" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "tools.pickerByPlugin" }));
    await user.click(within(dialog).getByRole("button", { name: /^Crm/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /deal/ }));
    await user.click(within(dialog).getByRole("button", { name: "tools.pickerConfirm" }));

    await waitFor(() => expect(screen.queryByText("tools.pickerTitle")).not.toBeInTheDocument());
    // `deal` cannot run without the CRM key, so its panel opens on the field.
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("CRM API key")).toBeInTheDocument();
    // Its key can be saved now; the panel says the tool itself waits for the page's Save.
    expect(within(sheet).getByText("tools.paramsBeforeTool")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(within(rowOf("deal")).getByText("tools.pendingEnable")).toBeInTheDocument();
    expect(lastSaveAction.current?.isDirty).toBe(true);
    expect(mockToolsUpdate).not.toHaveBeenCalled();

    await lastSaveAction.current!.onSave();
    expect(mockToolsUpdate).toHaveBeenCalledWith("agent-1", ["readFile", "saveMemory", "crm:contact", "crm:deal", "readSkill"]);
    expect(props.onToolsUpdate).toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("tools.saved");
  });

  it("asks before disabling a tool the agent has, and keeps the row until Save", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(within(rowOf("readFile")).getByRole("button", { name: "tools.disableTool" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("tools.disableConfirmBody")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "common.cancel" }));
    expect(lastSaveAction.current?.isDirty).toBe(false);

    await disable(user, "readFile");
    expect(within(rowOf("readFile")).getByText("tools.pendingDisable")).toBeInTheDocument();
    expect(lastSaveAction.current?.isDirty).toBe(true);

    await lastSaveAction.current!.onSave();
    expect(mockToolsUpdate).toHaveBeenCalledWith("agent-1", ["saveMemory", "crm:contact", "readSkill"]);
  });

  it("restores a tool pending removal, leaving nothing to save", async () => {
    const user = userEvent.setup();
    renderTab();

    await disable(user, "readFile");
    await user.click(screen.getByRole("button", { name: "tools.restore" }));

    expect(lastSaveAction.current?.isDirty).toBe(false);
    expect(screen.queryByText("tools.pendingDisable")).not.toBeInTheDocument();
  });

  it("disables a skill that needs the tool, after saying so, and writes the skill first", async () => {
    const user = userEvent.setup();
    const skills = [{ name: "reporting", description: "", enabled: true, requiredTools: ["readFile"] }] as SkillState[];
    renderTab({ skills });
    mockSkillsUpdate.mockResolvedValue({ skills: [] });

    await user.click(within(rowOf("readFile")).getByRole("button", { name: "tools.disableTool" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("tools.disableConfirmCascade")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "capabilities.confirm" }));

    await lastSaveAction.current!.onSave();
    expect(mockSkillsUpdate).toHaveBeenCalledWith("agent-1", []);
    expect(mockSkillsUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockToolsUpdate.mock.invocationCallOrder[0]);
  });

  it("warns beside a tool whose required parameter is not set", async () => {
    renderTab();

    expect(await within(rowOf("contact")).findByRole("img", { name: "tools.missingParams" })).toBeInTheDocument();
    expect(within(rowOf("readFile")).queryByRole("img")).not.toBeInTheDocument();
  });

  it("does not report parameters as missing when the secrets cannot be read", async () => {
    mockSecretsList.mockRejectedValue(new Forbidden());
    renderTab();

    await waitFor(() => expect(mockSecretsList).toHaveBeenCalled());
    await waitFor(() => expect(mockRequiredSecrets).toHaveBeenCalled());
    expect(within(rowOf("contact")).queryByRole("img")).not.toBeInTheDocument();
  });

  it("warns that a memory tool does nothing while memory is off", () => {
    renderTab({ memoryEnabled: false });

    expect(within(rowOf("saveMemory")).getByRole("img", { name: "tools.memoryDisabledHint" })).toBeInTheDocument();
  });

  it("opens a tool's panel: cleartext prefilled, secrets masked, provider keys pointed to the Model section", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(within(rowOf("contact")).getByRole("button", { name: "tools.open" }));
    const sheet = await screen.findByRole("dialog");

    expect(await within(sheet).findByDisplayValue("https://crm.example.com")).toHaveAttribute("type", "text");
    expect(within(sheet).getByText("The key of the CRM account.")).toBeInTheDocument();
    expect(within(sheet).getByPlaceholderText("settings.tab.keyPlaceholder")).toHaveAttribute("type", "password");
    // A provider credential is set in the Model section, never as a second field here.
    expect(within(sheet).getByText("OpenAI API Key")).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "tools.paramProviderCredential" })).toHaveAttribute("href", "?tab=settings");
    // A sibling from the same plugin has a switch of its own.
    expect(within(sheet).getByRole("switch", { name: /deal/ })).not.toBeChecked();
  });

  it("saves a typed parameter with the panel's own button, outside the page's draft", async () => {
    const user = userEvent.setup();
    const onConfigurationChanged = vi.fn();
    renderTab({ onConfigurationChanged });

    await user.click(within(rowOf("contact")).getByRole("button", { name: "tools.open" }));
    const sheet = await screen.findByRole("dialog");
    const save = within(sheet).getByRole("button", { name: "tools.paramsSave" });
    expect(save).toBeDisabled();

    await user.type(within(sheet).getByPlaceholderText("settings.tab.keyPlaceholder"), "sk-crm");
    // The page has nothing to save: a key is not part of the tools draft.
    expect(lastSaveAction.current?.isDirty).toBe(false);
    await user.click(save);

    await waitFor(() => expect(mockSecretsSet).toHaveBeenCalledWith("agent-1", [{ key: "crm_api_key", value: "sk-crm" }]));
    expect(mockToolsUpdate).not.toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith("tools.paramsSaved");
    expect(onConfigurationChanged).toHaveBeenCalled();
  });

  it("asks before closing a panel with unsaved parameter values", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(within(rowOf("contact")).getByRole("button", { name: "tools.open" }));
    const sheet = await screen.findByRole("dialog");
    await user.type(within(sheet).getByPlaceholderText("settings.tab.keyPlaceholder"), "sk-crm");
    await user.click(within(sheet).getByRole("button", { name: "common.close" }));

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("tools.discardTitle")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "tools.discardConfirm" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockSecretsSet).not.toHaveBeenCalled();
  });

  it("enables a sibling from inside the panel as a draft, without a toast", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(within(rowOf("contact")).getByRole("button", { name: "tools.open" }));
    const sheet = await screen.findByRole("dialog");
    // `contact` is saved: no note about waiting for the page's Save.
    expect(within(sheet).queryByText("tools.paramsBeforeTool")).not.toBeInTheDocument();

    await user.click(within(sheet).getByRole("switch", { name: /deal/ }));
    expect(mockToastSuccess).not.toHaveBeenCalledWith("tools.enabledPending");
    expect(lastSaveAction.current?.isDirty).toBe(true);
  });

  // Without a display name the namespace is humanized: the origin filter test below reads "Crm".
  it("names a plugin by its manifest's display name", () => {
    renderTab({ plugins: [{ namespace: "crm", name: "crm", version: "1.0.0", displayName: "CRM Suite" }] });
    expect(within(rowOf("contact")).getByText("CRM Suite")).toBeInTheDocument();
  });

  it("filters the table by origin", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole("button", { name: "tools.filterOrigin" }));
    await user.click(await screen.findByRole("menuitem", { name: "Crm" }));

    expect(screen.getByText("contact")).toBeInTheDocument();
    expect(screen.queryByText("readFile")).not.toBeInTheDocument();
  });

  it("reports a failed save", async () => {
    const user = userEvent.setup();
    renderTab();
    mockToolsUpdate.mockRejectedValue(new Error("boom"));

    await disable(user, "readFile");
    await lastSaveAction.current!.onSave();

    expect(mockToastError).toHaveBeenCalledWith("tools.saveFailed");
  });
});
