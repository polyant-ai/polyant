// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
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
  // The component does `reason instanceof ApiError` on load failures; without
  // this export it was `instanceof undefined` → TypeError, breaking the error path.
  ApiError: class ApiError extends Error {
    status?: number;
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
    temperature: null,
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
      { key: "aws_provider_access_key_id", configured: false },
      { key: "aws_provider_secret_access_key", configured: false },
      { key: "aws_provider_region", configured: false },
      { key: "langsmith_api_key", configured: false },
      { key: "auth_api_key", configured: false },
      { key: "tavily_api_key", configured: false },
    ],
  });
  mockModelsList.mockResolvedValue({
    providers: {
      openai: { models: [{ id: "gpt-4o", tier: "standard", costInput: 0.01, costOutput: 0.03, supportsThinking: false, supportsTemperature: true }] },
      anthropic: { models: [{ id: "claude-3-opus", tier: "heavy", costInput: 0.015, costOutput: 0.075, supportsThinking: false, supportsTemperature: true }] },
      bedrock: { models: [{ id: "titan", tier: "standard", costInput: 0.01, costOutput: 0.03, supportsThinking: false, supportsTemperature: true }] },
    },
  });
  // New shape: array of RequiredSecretSpec, not plain strings.
  mockToolsRequiredSecrets.mockResolvedValue({ requiredSecrets: [] });
}


/**
 * A switch that still LIVES in this tab, for tests that only need to dirty the
 * form. It was the memory switch, which moved to Generale — so a test using it to
 * make the form dirty was testing the move, not the save. Scoped by unique help
 * text rather than by index: index lookups (switches[0]/[3]) have already broken
 * once here when a new always-visible toggle shifted every switch down by one.
 */
function getDirtyingSwitch(): HTMLElement {
  const section = screen.getByText("settings.tab.authHelp").closest("section");
  return within(section as HTMLElement).getByRole("switch");
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

    // Dirty the form with a switch that still lives here.
    await user.click(getDirtyingSwitch());

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockInstanceUpdate).toHaveBeenCalledWith(
        "test-instance",
        // The flag the dirtying switch actually owns — `memoryEnabled` is not in this
        // tab's payload any more.
        expect.objectContaining({ authEnabled: true }),
      );
    });

    expect(onUpdate).toHaveBeenCalledWith(updatedInstance);
    expect(mockToastSuccess).toHaveBeenCalledWith("settings.tab.saved");
  });

  it("prompts for a destructive wipe and confirms it when the embedder changes (openai→bedrock)", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ memoryEnabled: true });
    mockInstanceUpdate.mockResolvedValueOnce({
      instance: makeInstance({ embeddingProvider: "bedrock" }),
    });

    render(<SettingsTab instance={instance} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Switch the embedder (independent of the chat LLM) to bedrock — this is
    // the change that invalidates existing embeddings and must trigger the wipe.
    const embedderTrigger = screen.getByRole("combobox", { name: "settings.tab.embedder" });
    embedderTrigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: /bedrock/i }));

    // Saving with an embedder change opens the destructive wipe dialog
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
        expect.objectContaining({ embeddingProvider: "bedrock", confirmWipe: true }),
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
    await user.click(getDirtyingSwitch());

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

  it("disables the temperature control for reasoning models", async () => {
    mockModelsList.mockResolvedValue({
      providers: {
        openai: {
          models: [
            { id: "o3", tier: "heavy", costInput: 0.01, costOutput: 0.03, supportsThinking: true, supportsTemperature: false },
          ],
        },
      },
    });

    render(
      <SettingsTab instance={makeInstance({ model: "o3" })} onUpdate={onUpdate} />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/temperature/i)).toBeDisabled();
  });

  it("keeps temperature editable under thinking for reasoners that accept both (gpt-oss/Nebius)", async () => {
    mockModelsList.mockResolvedValue({
      providers: {
        bedrock: {
          models: [
            { id: "openai.gpt-oss-120b-1:0", tier: "standard", costInput: 0.2, costOutput: 0.79, supportsThinking: true, supportsTemperature: true, supportsTemperatureWithThinking: true },
          ],
        },
      },
    });

    render(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "openai.gpt-oss-120b-1:0", thinkingEnabled: true })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Open-weight/vLLM reasoners accept temperature + reasoning together — the field
    // stays editable with thinking on (mirrors temperatureSupported(..., thinking:true)).
    expect(screen.getByLabelText(/temperature/i)).not.toBeDisabled();
  });

  it("disables temperature under thinking for strict-reasoning APIs (Anthropic/OpenAI 1P)", async () => {
    mockModelsList.mockResolvedValue({
      providers: {
        openai: {
          models: [
            { id: "gpt-5.4", tier: "heavy", costInput: 0.01, costOutput: 0.03, supportsThinking: true, supportsTemperature: true, supportsTemperatureWithThinking: false },
          ],
        },
      },
    });

    render(
      <SettingsTab instance={makeInstance({ model: "gpt-5.4", thinkingEnabled: true })} onUpdate={onUpdate} />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // gpt-5.4 takes a custom temperature only with reasoning OFF; under thinking the
    // field must lock (supportsTemperatureWithThinking:false).
    expect(screen.getByLabelText(/temperature/i)).toBeDisabled();
  });

  it("keeps temperature editable when a stale thinkingEnabled flag survives on a non-thinking model", async () => {
    mockModelsList.mockResolvedValue({
      providers: {
        bedrock: {
          models: [
            { id: "qwen3", tier: "standard", costInput: 0.01, costOutput: 0.03, supportsThinking: false, supportsTemperature: true },
          ],
        },
      },
    });

    render(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "qwen3", thinkingEnabled: true })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // The thinking toggle is hidden (model non-capable) but the persisted flag
    // must not lock the temperature field — mirrors the engine runtime gate.
    expect(screen.getByLabelText(/temperature/i)).not.toBeDisabled();
  });

  it("includes temperature in the save payload", async () => {
    const user = userEvent.setup();
    mockModelsList.mockResolvedValue({
      providers: {
        openai: {
          models: [
            { id: "gpt-4o", tier: "standard", costInput: 0.01, costOutput: 0.03, supportsThinking: false, supportsTemperature: true },
          ],
        },
      },
    });

    const instance = makeInstance({ model: "gpt-4o" });
    mockInstanceUpdate.mockResolvedValueOnce({ instance });

    render(<SettingsTab instance={instance} onUpdate={onUpdate} />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    const tempInput = screen.getByLabelText(/temperature/i);
    await user.clear(tempInput);
    await user.type(tempInput, "0.5");

    await lastSaveAction.current!.onSave();

    await waitFor(() => {
      expect(mockInstanceUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.objectContaining({ temperature: 0.5 }),
      );
    });
  });

  it("locks the thinking toggle ON with an always-on hint for a no-off reasoning model", async () => {
    mockModelsList.mockResolvedValue({
      providers: {
        bedrock: {
          models: [
            { id: "openai.gpt-oss-120b-1:0", tier: "standard", costInput: 0.2, costOutput: 0.79, supportsThinking: true, reasoningAlwaysOn: true, supportsTemperature: false },
          ],
        },
      },
    });

    render(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "openai.gpt-oss-120b-1:0", thinkingEnabled: false })}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // gpt-oss reasons on every call: the UI states it (hint) instead of a working
    // off switch, and the toggle is locked ON + disabled.
    expect(screen.getByText("settings.tab.thinkingAlwaysOn")).toBeInTheDocument();

    const thinkingBlock = screen.getByText("settings.tab.thinking").closest("div.flex");
    const toggle = within(thinkingBlock as HTMLElement).getByRole("switch");
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
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
