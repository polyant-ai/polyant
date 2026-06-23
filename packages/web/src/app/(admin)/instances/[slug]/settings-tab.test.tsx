// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsTab } from "./settings-tab";
import type { Instance } from "@/lib/api";

// ── Mocks ──────────────────────────────────────────────────────────────

const {
  mockToastSuccess,
  mockToastError,
  mockInstanceUpdate,
  mockSecretsList,
  mockSecretsSet,
  mockSecretsDelete,
  mockModelsList,
  mockToolsRequiredSecrets,
} = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockInstanceUpdate: vi.fn(),
  mockSecretsList: vi.fn(),
  mockSecretsSet: vi.fn(),
  mockSecretsDelete: vi.fn(),
  mockModelsList: vi.fn(),
  mockToolsRequiredSecrets: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Top-bar Save action registration mock — captures the most recent
// registration so assertions can read isDirty/saving and invoke onSave
// directly without rendering the top bar.
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
    secrets: {
      list: (...args: unknown[]) => mockSecretsList(...args),
      set: (...args: unknown[]) => mockSecretsSet(...args),
      delete: (...args: unknown[]) => mockSecretsDelete(...args),
    },
    models: { list: (...args: unknown[]) => mockModelsList(...args) },
    tools: { requiredSecrets: (...args: unknown[]) => mockToolsRequiredSecrets(...args) },
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
  };
}

function setupDefaultMocks() {
  mockSecretsList.mockResolvedValue({
    secrets: [
      { key: "openai_api_key", configured: true },
      { key: "anthropic_api_key", configured: false },
      { key: "aws_access_key_id", configured: false },
      { key: "aws_secret_access_key", configured: false },
      { key: "aws_region", configured: false },
      { key: "langsmith_api_key", configured: false },
      { key: "auth_api_key", configured: false },
      { key: "tavily_api_key", configured: false },
    ],
  });
  mockModelsList.mockResolvedValue({
    providers: {
      openai: { models: [{ id: "gpt-4o", tier: "standard", costInput: 0.01, costOutput: 0.03 }] },
      anthropic: { models: [{ id: "claude-3-opus", tier: "heavy", costInput: 0.015, costOutput: 0.075 }] },
      bedrock: { models: [{ id: "titan", tier: "standard", costInput: 0.01, costOutput: 0.03 }] },
    },
  });
  // New shape: array of RequiredSecretSpec, not plain strings.
  mockToolsRequiredSecrets.mockResolvedValue({ requiredSecrets: [] });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("SettingsTab", () => {
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("shows loading skeleton initially", () => {
    // Delay API response to observe loading state
    mockSecretsList.mockReturnValue(new Promise(() => {}));
    mockModelsList.mockReturnValue(new Promise(() => {}));

    const { container } = render(
      <SettingsTab instance={makeInstance()} onUpdate={onUpdate} />,
    );

    // Loading state renders pulse divs
    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBeGreaterThan(0);
  });

  it("renders all sections after loading", async () => {
    render(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    expect(screen.getByText("settings.tab.apiKeys")).toBeInTheDocument();
    // "settings.tab.memory" appears twice (section title + switch label)
    expect(screen.getAllByText("settings.tab.memory").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("settings.tab.auth")).toBeInTheDocument();
    expect(screen.getByText("settings.tab.langsmith")).toBeInTheDocument();
  });

  it("loads secrets and models on mount", async () => {
    render(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(mockSecretsList).toHaveBeenCalledWith("test-instance");
      expect(mockModelsList).toHaveBeenCalled();
    });
  });

  it("shows configured badge for secrets that are set", async () => {
    render(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // OpenAI key is configured in our mock, so we expect at least one "configured" badge
    const configuredBadges = screen.getAllByText("settings.tab.configured");
    expect(configuredBadges.length).toBeGreaterThan(0);
  });

  it("shows not-configured badge for secrets that are not set", async () => {
    render(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    const notConfiguredBadges = screen.getAllByText("settings.tab.notConfigured");
    expect(notConfiguredBadges.length).toBeGreaterThan(0);
  });

  it("does not show save button when nothing is changed", async () => {
    render(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    expect(lastSaveAction.current?.isDirty).toBe(false);
  });

  it("shows save button when memory toggle is changed", async () => {
    const user = userEvent.setup();
    render(
      <SettingsTab instance={makeInstance({ memoryEnabled: false })} onUpdate={onUpdate} />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Find memory toggle: the switches are in order - memory is the first one after the selects
    const switches = screen.getAllByRole("switch");
    // The first switch is memory toggle
    const memorySwitch = switches[0];
    await user.click(memorySwitch);

    expect(lastSaveAction.current?.isDirty).toBe(true);
  });

  it("shows the openai memory warning when the engine reports needsOpenAIKey", async () => {
    render(
      <SettingsTab
        instance={makeInstance({
          memoryEnabled: true,
          provider: "openai",
          memory: { needsOpenAIKey: true, canEnable: false },
        })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("memory.banner.openaiNeedsKey")).toBeInTheDocument();
    });
  });

  it("shows the anthropic memory warning for an anthropic instance needing an openai key", async () => {
    render(
      <SettingsTab
        instance={makeInstance({
          memoryEnabled: true,
          provider: "anthropic",
          model: "claude-3-opus",
          memory: { needsOpenAIKey: true, canEnable: false },
        })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("memory.banner.anthropicNeedsOpenAI")).toBeInTheDocument();
    });
  });

  it("shows the bedrock memory warning for a bedrock instance needing aws credentials", async () => {
    mockModelsList.mockResolvedValue({
      providers: {
        bedrock: { models: [{ id: "titan", tier: "standard", costInput: 0.01, costOutput: 0.03 }] },
      },
    });

    render(
      <SettingsTab
        instance={makeInstance({
          memoryEnabled: true,
          provider: "bedrock",
          model: "titan",
          memory: { needsOpenAIKey: true, canEnable: false },
        })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("memory.banner.bedrockNeedsAws")).toBeInTheDocument();
    });
  });

  it("does not show the memory warning when the engine reports no missing key", async () => {
    render(
      <SettingsTab
        instance={makeInstance({
          memoryEnabled: true,
          memory: { needsOpenAIKey: false, canEnable: true },
        })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    expect(screen.queryByText("memory.banner.openaiNeedsKey")).not.toBeInTheDocument();
  });

  it("shows auth key field when authEnabled is true", async () => {
    render(
      <SettingsTab instance={makeInstance({ authEnabled: true })} onUpdate={onUpdate} />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.authApiKey")).toBeInTheDocument();
    });
  });

  it("does not show auth key field when authEnabled is false", async () => {
    render(
      <SettingsTab instance={makeInstance({ authEnabled: false })} onUpdate={onUpdate} />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    expect(screen.queryByText("settings.tab.authApiKey")).not.toBeInTheDocument();
  });

  it("shows langsmith project and key fields when langsmith is enabled", async () => {
    render(
      <SettingsTab
        instance={makeInstance({ langsmithEnabled: true })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.langsmithProject")).toBeInTheDocument();
    });

    expect(screen.getByText("settings.tab.langsmithApiKey")).toBeInTheDocument();
  });

  it("does not show langsmith details when langsmith is disabled", async () => {
    render(
      <SettingsTab
        instance={makeInstance({ langsmithEnabled: false })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    expect(screen.queryByText("settings.tab.langsmithProject")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tab.langsmithApiKey")).not.toBeInTheDocument();
  });

  it("saves instance settings and secrets on save", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ memoryEnabled: false });
    const updatedInstance = makeInstance({ memoryEnabled: true });
    mockInstanceUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    render(<SettingsTab instance={instance} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Toggle memory on to create a dirty state. Switch order in the AI-model +
    // memory sections: [0] = "state in prompt", [1] = "tool results in history",
    // [2] = "debug mode", [3] = memory; the thinking toggle is hidden for
    // non-reasoning models (gpt-4o).
    const switches = screen.getAllByRole("switch");
    await user.click(switches[3]); // memory switch

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockInstanceUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.objectContaining({ memoryEnabled: true }),
      );
    });

    expect(onUpdate).toHaveBeenCalledWith(updatedInstance);
    expect(mockToastSuccess).toHaveBeenCalledWith("settings.tab.saved");
  });

  it("prompts for a destructive wipe and confirms it when the embedding provider changes (openai→bedrock)", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ provider: "openai", model: "gpt-4o", memoryEnabled: true });
    const updatedInstance = makeInstance({ provider: "bedrock", model: "titan" });
    mockInstanceUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    render(<SettingsTab instance={instance} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Switch provider to bedrock via the pricing dialog (a Table-row click,
    // which works under jsdom — unlike the Radix Select trigger which needs
    // pointer-capture APIs jsdom doesn't implement).
    await user.click(screen.getByText("settings.tab.viewPricing"));
    await user.click(await screen.findByText("titan"));

    // Saving with an embedding-provider change opens the destructive wipe dialog
    // instead of saving directly.
    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(screen.getByText("memory.wipe.title")).toBeInTheDocument();
    });
    expect(mockInstanceUpdate).not.toHaveBeenCalled();

    // Confirming runs the save and passes confirmWipe so the engine wipes the data.
    await user.click(screen.getByText("memory.wipe.primary"));

    await waitFor(() => {
      expect(mockInstanceUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.objectContaining({ provider: "bedrock", confirmWipe: true }),
      );
    });
  });

  it("does not prompt for a wipe when the embedding provider is unchanged (openai→anthropic)", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ provider: "openai", model: "gpt-4o", memoryEnabled: true });
    const updatedInstance = makeInstance({ provider: "anthropic", model: "claude-3-opus" });
    mockInstanceUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    render(<SettingsTab instance={instance} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // openai → anthropic keeps the same embedding provider (openai), so no wipe.
    await user.click(screen.getByText("settings.tab.viewPricing"));
    await user.click(await screen.findByText("claude-3-opus"));
    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockInstanceUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.objectContaining({ provider: "anthropic", confirmWipe: false }),
      );
    });
    expect(screen.queryByText("memory.wipe.title")).not.toBeInTheDocument();
  });

  it("saves secrets when api key fields are filled", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    const updatedInstance = makeInstance();

    mockSecretsSet.mockResolvedValueOnce({
      secrets: [{ key: "openai_api_key", configured: true }],
    });
    mockInstanceUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    render(<SettingsTab instance={instance} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Type into the OpenAI key field (first password input in the API keys section)
    const passwordInputs = screen.getAllByPlaceholderText("settings.tab.keyPlaceholderSet");
    await user.type(passwordInputs[0], "sk-test-key");

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockSecretsSet).toHaveBeenCalledWith(
        "test-instance",
        expect.arrayContaining([
          expect.objectContaining({ key: "openai_api_key", value: "sk-test-key" }),
        ]),
      );
    });
  });

  it("shows error toast on save failure", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ memoryEnabled: false });
    mockInstanceUpdate.mockRejectedValueOnce(new Error("Server error"));

    render(<SettingsTab instance={instance} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Toggle memory to trigger dirty state
    const switches = screen.getAllByRole("switch");
    await user.click(switches[0]);

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("settings.tab.saveFailed");
    });
  });

  it("shows error toast on initial load failure", async () => {
    mockSecretsList.mockRejectedValueOnce(new Error("Load error"));

    render(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("settings.tab.loadFailed");
    });
  });
});

describe("SettingsTab — tool secret rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretsList.mockResolvedValue({ secrets: [] });
    mockModelsList.mockResolvedValue({ providers: { openai: { models: [] } } });
  });

  it("renders a readable (sensitive:false) tool secret as a prefilled cleartext input", async () => {
    mockToolsRequiredSecrets.mockResolvedValue({
      requiredSecrets: [
        {
          key: "service_base_url",
          type: "text",
          sensitive: false,
          label: "Service base URL",
          currentValue: "https://api.example.com",
        },
        { key: "service_api_key", type: "text", sensitive: true, label: "Service API key" },
      ],
    });

    render(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} />);

    const readable = await screen.findByDisplayValue("https://api.example.com");
    expect(readable).toHaveAttribute("type", "text");
  });

  it("renders a sensitive tool secret as a masked (password) input with no prefill", async () => {
    mockToolsRequiredSecrets.mockResolvedValue({
      requiredSecrets: [
        { key: "service_api_key", type: "text", sensitive: true, label: "Service API key" },
      ],
    });

    const { container } = render(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} />);

    await screen.findByText("Service API key");
    expect(screen.queryByDisplayValue("https://api.example.com")).toBeNull();
    const masked = Array.from(container.querySelectorAll("input")).filter(
      (i) => i.getAttribute("type") === "password",
    );
    expect(masked.length).toBeGreaterThan(0);
  });
});
