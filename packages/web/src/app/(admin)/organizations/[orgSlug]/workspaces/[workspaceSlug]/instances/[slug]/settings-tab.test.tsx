// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { SettingsTab } from "./settings-tab";
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

vi.mock("@/lib/tenant/use-org-slug", () => ({ useOrgSlug: () => "acme" }));

// Hoisted: the `@/lib/api` factory below runs before the imports, so the class
// backing both `ApiError` and `isForbidden` has to exist by then — and it must
// be the SAME class for the `instanceof` inside the predicate to hold.
const { MockApiError } = vi.hoisted(() => ({
  MockApiError: class ApiError extends Error {
    status?: number;
  },
}));

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
    instances: { update: (...args: unknown[]) => mockInstanceUpdate(...args) },
    secrets: {
      list: (...args: unknown[]) => mockSecretsList(...args),
      set: (...args: unknown[]) => mockSecretsSet(...args),
      delete: (...args: unknown[]) => mockSecretsDelete(...args),
    },
    models: { list: (...args: unknown[]) => mockModelsList(...args) },
    tools: { requiredSecrets: (...args: unknown[]) => mockToolsRequiredSecrets(...args) },
  },
  // The component asks `isForbidden(reason)` on load failures. Mocking the whole
  // module means every export it reaches for has to be declared here, and a
  // missing one is `undefined(...)` at the first failed load — not a type error.
  ApiError: MockApiError,
  isForbidden: (err: unknown) => err instanceof MockApiError && err.status === 403,
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
  mockToolsRequiredSecrets.mockResolvedValue({ requiredSecrets: [] });
}

/** The provider section carrying `titleKey`, or null when it isn't rendered. */
function providerSection(titleKey: string): HTMLElement | null {
  return screen.queryByText(titleKey)?.closest("section") ?? null;
}

/**
 * A switch of the `params` half, for tests that only need to dirty that form.
 *
 * Was the memory switch, which moved to Generale. Located by its unique help text
 * rather than by index: index-based lookups (switches[0]/[3]) broke when the
 * always-visible thinking toggle (#178) shifted every switch down by one, and
 * they would have broken again now.
 */
function getDirtyingSwitch(): HTMLElement {
  const row = screen.getByText("settings.tab.debugHelp").closest("div")?.parentElement;
  return within(row as HTMLElement).getByRole("switch");
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

    const { container } = renderWithProvider(
      <SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />,
    );

    // Loading state renders pulse divs
    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBeGreaterThan(0);
  });

  /**
   * Memory and the knowledge switch left this tab: memory to Generale (with its
   * embedder-keyed warning, whose three cases moved to `general-tab.test.tsx` —
   * #150 lives there now) and the knowledge switch to the Knowledge tab.
   *
   * The knowledge CREDENTIALS warning has no new home: it was computed here from
   * the secrets list, and the Knowledge tab does not load them. That gap is
   * recorded in `knowledge-tab.tsx` rather than papered over with a third copy of
   * "is the embedder configured".
   */
  it("renders the model page: the model, the audio picker and the parameters", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // The behaviour parameters are NOT here: they went to Parametri, with memory
    // and the diagnostics.
    expect(screen.queryByText("settings.tab.params")).not.toBeInTheDocument();
    // Speech-to-text stays: it IS part of which AI runs this agent.
    expect(screen.getByText("settings.tab.stt")).toBeInTheDocument();
    // CREDENTIALS are not here: they have one home, and a key rendered beside the
    // model picker is how they came to have three. Asserted absent so a revert is loud.
    expect(screen.queryByText("settings.tab.provider.openai")).not.toBeInTheDocument();
    // Memory and the knowledge switch left earlier, to Conoscenza e memoria.
    expect(screen.queryByText("settings.tab.memory")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tab.knowledge")).not.toBeInTheDocument();
    // LangSmith too — it traces what the agent DOES, which is not a property of
    // the model. It is in Generale now, tested there.
    expect(screen.queryByText("settings.tab.langsmith")).not.toBeInTheDocument();
  });

  /** The other half: every key the agent uses, and nothing that configures a model. */
  it("renders the credentials page: the provider keys, no model picker", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="credentials" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.provider.openai")).toBeInTheDocument();
    });

    expect(screen.queryByText("settings.tab.aiModel")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tab.params")).not.toBeInTheDocument();
  });

  it("loads secrets and models on mount", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(mockSecretsList).toHaveBeenCalledWith("test-instance");
      expect(mockModelsList).toHaveBeenCalled();
    });
  });

  it("shows configured badge for secrets that are set", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="credentials" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.provider.openai")).toBeInTheDocument();
    });

    // OpenAI key is configured in our mock, so we expect at least one "configured" badge
    const configuredBadges = screen.getAllByText("settings.tab.configured");
    expect(configuredBadges.length).toBeGreaterThan(0);
  });

  it("shows not-configured badge for secrets that are not set", async () => {
    // A bedrock agent: its AWS keys are unset in the mock, and only a provider
    // the agent uses renders a section at all.
    renderWithProvider(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "titan" })}
        onUpdate={onUpdate}
        section="credentials"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.awsCredentials")).toBeInTheDocument();
    });

    const notConfiguredBadges = screen.getAllByText("settings.tab.notConfigured");
    expect(notConfiguredBadges.length).toBeGreaterThan(0);
  });

  it("does not show save button when nothing is changed", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    expect(screen.queryByText("common.save")).not.toBeInTheDocument();
  });







  // ── Provider sections ───────────────────────────────────────────────
  // One section per provider, and EVERY provider — a credential must be
  // enterable before the agent is pointed at the provider that needs it.

  it("groups each provider's keys under that provider's own section", async () => {
    renderWithProvider(
      <SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="credentials" />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.provider.openai")).toBeInTheDocument();
    });

    const openai = providerSection("settings.tab.provider.openai") as HTMLElement;
    expect(within(openai).getByText("settings.tab.openaiKey")).toBeInTheDocument();
    // And it holds only its own key, however many sections are on the page.
    expect(within(openai).queryByText("settings.tab.anthropicKey")).not.toBeInTheDocument();
  });

  // The rule this replaced showed a provider's section only once that provider
  // was already selected for chat, the embedder or STT — so preparing an agent
  // for Bedrock before switching it to Bedrock was impossible.
  it("offers every provider's credentials whatever this agent currently runs on", async () => {
    renderWithProvider(
      <SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="credentials" />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.provider.openai")).toBeInTheDocument();
    });

    expect(screen.getByText("settings.tab.anthropicKey")).toBeInTheDocument();
    expect(screen.getByText("settings.tab.nebiusKey")).toBeInTheDocument();
    expect(screen.getByText("settings.tab.bedrockApiKey")).toBeInTheDocument();
    // Deepgram too: it is reached only through the speech-to-text picker, which
    // is exactly the choice that used to hide its key until it was made.
    expect(screen.getByText("settings.tab.deepgramKey")).toBeInTheDocument();
  });

  // LangSmith is the one section Credenziali does not render: its key sits beside
  // the tracing switch (`langsmith-card.tsx`), with its own save. A placement
  // decision, not a gate — but two fields for one key is what this excludes.
  it("leaves the LangSmith key to the card that owns the switch", async () => {
    renderWithProvider(
      <SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="credentials" />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.provider.openai")).toBeInTheDocument();
    });

    expect(screen.queryByText("settings.tab.provider.langsmith")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tab.langsmithApiKey")).not.toBeInTheDocument();
  });

  it("keeps the AWS credential set together in one section", async () => {
    renderWithProvider(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "titan" })}
        onUpdate={onUpdate}
        section="credentials"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.awsCredentials")).toBeInTheDocument();
    });

    const aws = providerSection("settings.tab.awsCredentials") as HTMLElement;
    for (const label of [
      "settings.tab.bedrockApiKey",
      "settings.tab.awsAccessKeyId",
      "settings.tab.awsSecretAccessKey",
      "settings.tab.awsRegion",
    ]) {
      expect(within(aws).getByText(label)).toBeInTheDocument();
    }
    // The chat provider is bedrock, but OpenAI is still the embedder default,
    // so its section shows on its own account — never inside the AWS one.
    expect(within(aws).queryByText("settings.tab.openaiKey")).not.toBeInTheDocument();
  });

  /**
   * Credentials follow the SAVED provider, not the one currently picked.
   *
   * While both lived on one page, switching the provider revealed its key fields
   * immediately — nobody had to save a provider they could not yet authenticate.
   * Separate pages cost that: the credentials page reads the agent as persisted, so
   * the order is now choose → save → authenticate.
   */
  it("shows the keys of the saved provider, not of an unsaved selection", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="model" />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Pick an anthropic model from the catalog — the same path the wipe tests use.
    await user.click(screen.getByText("settings.tab.viewPricing"));
    await user.click(await screen.findByText("claude-3-opus"));

    // No key field appears here, and nothing was written.
    expect(screen.queryByText("settings.tab.anthropicKey")).not.toBeInTheDocument();
    expect(mockInstanceUpdate).not.toHaveBeenCalled();
  });

  it("reports a key set nowhere as not configured", async () => {
    mockSecretsList.mockResolvedValue({ secrets: [{ key: "openai_api_key", configured: false }] });

    renderWithProvider(
      <SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="credentials" />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.provider.openai")).toBeInTheDocument();
    });

    const openai = providerSection("settings.tab.provider.openai") as HTMLElement;
    expect(within(openai).getByText("settings.tab.notConfigured")).toBeInTheDocument();
  });

  /**
   * The inbound API key and its switch are NOT here any more: they gate the HTTP
   * surface, so they live with the Web/API channel (`channel-web-tab.test.tsx`).
   * Asserted as an ABSENCE, because leaving a second copy behind is how one of the
   * two ends up being the stale one.
   */
  it("no longer renders the inbound API key — it moved to the Web/API channel", async () => {
    renderWithProvider(
      <SettingsTab instance={makeInstance({ authEnabled: true })} onUpdate={onUpdate} section="model" />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    expect(screen.queryByText("settings.tab.authApiKey")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tab.authEnabled")).not.toBeInTheDocument();
  });



  it("saves instance settings and secrets on save", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ debugEnabled: false });
    const updatedInstance = makeInstance({ debugEnabled: true });
    mockInstanceUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    // A behaviour parameter, so the `params` page — the model page no longer
    // carries them, and its payload no longer mentions them.
    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="params" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.params")).toBeInTheDocument();
    });

    await user.click(getDirtyingSwitch());

    const saveBtn = screen.getByText("common.save");
    await user.click(saveBtn);

    await waitFor(() => {
      expect(mockInstanceUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.objectContaining({ debugEnabled: true }),
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

    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="model" />);

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
    await user.click(screen.getByText("common.save"));

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

    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // openai → anthropic keeps the same embedding provider (openai), so no wipe.
    await user.click(screen.getByText("settings.tab.viewPricing"));
    await user.click(await screen.findByText("claude-3-opus"));
    await user.click(screen.getByText("common.save"));

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

    mockSecretsSet.mockResolvedValueOnce({
      secrets: [{ key: "openai_api_key", configured: true }],
    });
    // No `instances.update` mock, deliberately: the credentials page has no
    // instance fields, so it must not call that endpoint at all — asserted below.
    // (A queued `mockResolvedValueOnce` here also leaked into the next test, which
    // expected a rejection and got this success instead.)

    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="credentials" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.provider.openai")).toBeInTheDocument();
    });

    // Type into the OpenAI key field (first password input in the API keys section)
    const passwordInputs = screen.getAllByPlaceholderText("settings.tab.keyPlaceholderSet");
    await user.type(passwordInputs[0], "sk-test-key");

    const saveBtn = screen.getByText("common.save");
    await user.click(saveBtn);

    await waitFor(() => {
      expect(mockSecretsSet).toHaveBeenCalledWith(
        "test-instance",
        expect.arrayContaining([
          expect.objectContaining({ key: "openai_api_key", value: "sk-test-key" }),
        ]),
      );
    });
    // The credentials page writes secrets and nothing else.
    expect(mockInstanceUpdate).not.toHaveBeenCalled();
  });

  it("shows error toast on save failure", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ memoryEnabled: false });
    mockInstanceUpdate.mockRejectedValueOnce(new Error("Server error"));

    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    // Dirtied through the temperature: an instance field, so the failing call is
    // `instances.update`.
    await user.clear(screen.getByLabelText(/temperature/i));
    await user.type(screen.getByLabelText(/temperature/i), "0.7");

    const saveBtn = screen.getByText("common.save");
    await user.click(saveBtn);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("settings.tab.saveFailed");
    });
  });

  it("shows error toast on initial load failure", async () => {
    mockSecretsList.mockRejectedValueOnce(new Error("Load error"));

    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

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

    renderWithProvider(
      <SettingsTab instance={makeInstance({ model: "o3" })} onUpdate={onUpdate} section="model" />,
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

    renderWithProvider(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "openai.gpt-oss-120b-1:0", thinkingEnabled: true })}
        onUpdate={onUpdate}
        section="model"
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

    renderWithProvider(
      <SettingsTab instance={makeInstance({ model: "gpt-5.4", thinkingEnabled: true })} onUpdate={onUpdate} section="model" />,
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

    renderWithProvider(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "qwen3", thinkingEnabled: true })}
        onUpdate={onUpdate}
        section="model"
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

    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.aiModel")).toBeInTheDocument();
    });

    const tempInput = screen.getByLabelText(/temperature/i);
    await user.clear(tempInput);
    await user.type(tempInput, "0.5");

    await user.click(screen.getByText("common.save"));

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

    renderWithProvider(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "openai.gpt-oss-120b-1:0", thinkingEnabled: false })}
        onUpdate={onUpdate}
        section="model"
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

    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} section="toolSecrets" />);

    const readable = await screen.findByDisplayValue("https://api.example.com");
    expect(readable).toHaveAttribute("type", "text");
  });

  it("renders a sensitive tool secret as a masked (password) input with no prefill", async () => {
    mockToolsRequiredSecrets.mockResolvedValue({
      requiredSecrets: [
        { key: "service_api_key", type: "text", sensitive: true, label: "Service API key" },
      ],
    });

    const { container } = renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} section="toolSecrets" />);

    await screen.findByText("Service API key");
    expect(screen.queryByDisplayValue("https://api.example.com")).toBeNull();
    const masked = Array.from(container.querySelectorAll("input")).filter(
      (i) => i.getAttribute("type") === "password",
    );
    expect(masked.length).toBeGreaterThan(0);
  });

  // A tool may declare a PROVIDER key (`claudeCode` asks for `anthropic_api_key`)
  // and reads the very key the agent already holds. Credenziali renders those, so
  // this page must not offer a second field for one credential.
  it("leaves a provider credential a tool declares to the Credenziali page", async () => {
    mockToolsRequiredSecrets.mockResolvedValue({
      requiredSecrets: [
        { key: "anthropic_api_key", type: "text", sensitive: true, label: "Anthropic API Key" },
        { key: "aws_provider_region", type: "text", sensitive: false, label: "AWS Region" },
        { key: "deepgram_api_key", type: "text", sensitive: true, label: "Deepgram API Key" },
        { key: "service_api_key", type: "text", sensitive: true, label: "Service API key" },
      ],
    });

    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} section="toolSecrets" />);

    await screen.findByText("Service API key");
    expect(screen.queryByText("Anthropic API Key")).toBeNull();
    expect(screen.queryByText("AWS Region")).toBeNull();
    expect(screen.queryByText("Deepgram API Key")).toBeNull();
  });

  // ...and when a provider key is ALL a tool asked for, the page is empty rather
  // than showing a credential this surface does not own.
  it("shows the empty state when every required secret is a provider credential", async () => {
    mockToolsRequiredSecrets.mockResolvedValue({
      requiredSecrets: [
        { key: "openai_api_key", type: "text", sensitive: true, label: "OpenAI API Key" },
      ],
    });

    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} section="toolSecrets" />);

    await screen.findByText("settings.tab.noRequiredSecrets");
    expect(screen.queryByText("OpenAI API Key")).toBeNull();
  });
});
