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
    <>
      {saveAction.blockedReason && <span>{saveAction.blockedReason}</span>}
      <button
        onClick={() => saveAction.onSave()}
        disabled={saveAction.saving || Boolean(saveAction.blockedReason)}
      >
        {saveAction.saving ? "common.saving" : "common.save"}
      </button>
    </>
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
    effectiveProvider: "openai",
    effectiveModel: "gpt-4o",
    memoryEnabled: true,
    knowledgeEnabled: false,
    langsmithEnabled: false,
    langsmithProject: null,
    authEnabled: false,
    thinkingEnabled: false,
    stateInPromptEnabled: false,
    datetimeInjectionEnabled: true,
  datetimeTimezone: null,
  datetimeLocale: null,
  dedupSimilarityThreshold: null,
  messageSoftDebounceMs: null,
  messageTypingDelayMs: null,
  messageMaxRestarts: null,
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
    // The embedder select renders from THIS list, not from a copy in the
    // component — a copy pinned to two names is what made a registered embedder
    // unselectable.
    embedders: [
      { id: "openai", supportedDims: [1024, 1536] },
      { id: "bedrock", supportedDims: [1024] },
    ],
  });
  mockToolsRequiredSecrets.mockResolvedValue({ requiredSecrets: [] });
}

/** The model's tuning (reasoning, temperature, cache) is folded away: open it. */
async function openTuning() {
  await userEvent.click(screen.getByText("settings.tab.modelTuning"));
}

/** The block of one task (Conversazione, Embedding, Trascrizione), by its title. */
function roleBlock(titleKey: string): HTMLElement {
  return screen.getByText(titleKey).closest("section") as HTMLElement;
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

  it("marks a task ready when its provider's key is stored", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

    await waitFor(() => expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument());
    expect(within(roleBlock("settings.role.chat.title")).getByText("settings.role.ready")).toBeInTheDocument();
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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });

    // The behaviour parameters are NOT here: they went to Parametri, with memory
    // and the diagnostics.
    expect(screen.queryByText("settings.tab.params")).not.toBeInTheDocument();
    // One block per task the agent uses a provider for.
    expect(screen.getByText("settings.role.embed.title")).toBeInTheDocument();
    expect(screen.getByText("settings.role.stt.title")).toBeInTheDocument();
    // The chat provider's key is HERE now, in the block of the task that uses it:
    // the separate credentials page is gone.
    expect(within(roleBlock("settings.role.chat.title")).getByText("settings.tab.openaiKey")).toBeInTheDocument();
    // Memory and the knowledge switch left earlier, to Conoscenza e memoria.
    expect(screen.queryByText("settings.tab.memory")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tab.knowledge")).not.toBeInTheDocument();
    // LangSmith too — it traces what the agent DOES, which is not a property of
    // the model. It is in Generale now, tested there.
    expect(screen.queryByText("settings.tab.langsmith")).not.toBeInTheDocument();
  });

  it("loads secrets and models on mount", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(mockSecretsList).toHaveBeenCalledWith("test-instance");
      expect(mockModelsList).toHaveBeenCalled();
    });
  });

  it("shows configured badge for secrets that are set", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.tab.openaiKey")).toBeInTheDocument();
    });

    // OpenAI key is configured in our mock, so we expect at least one "configured" badge
    const configuredBadges = screen.getAllByText("settings.tab.configured");
    expect(configuredBadges.length).toBeGreaterThan(0);
  });

  it("shows not-configured badge for secrets that are not set", async () => {
    // A bedrock agent: its AWS keys are unset in the mock.
    renderWithProvider(
      <SettingsTab
        instance={makeInstance({ provider: "bedrock", model: "titan" })}
        onUpdate={onUpdate}
        section="model"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.awsAccessKeyId")).toBeInTheDocument();
    });

    const notConfiguredBadges = screen.getAllByText("settings.tab.notConfigured");
    expect(notConfiguredBadges.length).toBeGreaterThan(0);
  });

  it("does not show save button when nothing is changed", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });

    expect(screen.queryByText("common.save")).not.toBeInTheDocument();
  });







  // ── Credentials by task ─────────────────────────────────────────────
  // A key is set in the block of the task that uses it, next to the choice.

  it("shows a credential set once when two tasks use the same provider", async () => {
    // OpenAI for chat AND for embeddings (the default embedder).
    renderWithProvider(<SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="model" />);

    await waitFor(() => expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument());

    expect(screen.getAllByText("settings.tab.openaiKey")).toHaveLength(1);
    expect(within(roleBlock("settings.role.chat.title")).getByText("settings.tab.openaiKey")).toBeInTheDocument();
    expect(within(roleBlock("settings.role.embed.title")).getByText("settings.tab.credentialShared")).toBeInTheDocument();
    // The keys of a provider no task uses are not offered as fields.
    expect(screen.queryByText("settings.tab.anthropicKey")).not.toBeInTheDocument();
  });

  // The old page showed a key only once its provider was SAVED, so the order was
  // choose → save → authenticate, and a provider was saved before it could work.
  it("reveals a provider's key as soon as it is chosen, before anything is saved", async () => {
    const user = userEvent.setup();
    renderWithProvider(<SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="model" />);

    await waitFor(() => expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument());
    await user.click(screen.getByText("settings.tab.viewPricing"));
    await user.click(await screen.findByText("claude-3-opus"));

    expect(within(roleBlock("settings.role.chat.title")).getByText("settings.tab.anthropicKey")).toBeInTheDocument();
    expect(mockInstanceUpdate).not.toHaveBeenCalled();
  });

  it("blocks Save while a task lacks its credential, and says which", async () => {
    const user = userEvent.setup();
    mockInstanceUpdate.mockResolvedValue({ instance: makeInstance({ provider: "anthropic", model: "claude-3-opus" }) });
    mockSecretsSet.mockResolvedValue({ secrets: [{ key: "anthropic_api_key", configured: true }] });
    renderWithProvider(<SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="model" />);

    await waitFor(() => expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument());
    await user.click(screen.getByText("settings.tab.viewPricing"));
    await user.click(await screen.findByText("claude-3-opus"));

    expect(within(roleBlock("settings.role.chat.title")).getByText("settings.role.missing")).toBeInTheDocument();
    expect(screen.getByText("settings.tab.credentialMissingFor")).toBeInTheDocument();
    expect(screen.getByText("common.save")).toBeDisabled();

    // Typing the key is enough: it is saved together with the choice.
    const chat = roleBlock("settings.role.chat.title");
    await user.type(within(chat).getByPlaceholderText("settings.tab.keyPlaceholder"), "sk-ant-test");
    expect(screen.getByText("common.save")).toBeEnabled();
    await user.click(screen.getByText("common.save"));

    await waitFor(() =>
      expect(mockSecretsSet).toHaveBeenCalledWith(
        "test-instance",
        expect.arrayContaining([expect.objectContaining({ key: "anthropic_api_key", value: "sk-ant-test" })]),
      ),
    );
    expect(mockInstanceUpdate).toHaveBeenCalledWith("test-instance", expect.objectContaining({ provider: "anthropic" }));
  });

  it("treats an empty AWS block as working: Bedrock falls back to the host's role", async () => {
    renderWithProvider(
      <SettingsTab instance={makeInstance({ provider: "bedrock", model: "titan" })} onUpdate={onUpdate} section="model" />,
    );

    await waitFor(() => expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument());
    const chat = roleBlock("settings.role.chat.title");
    for (const label of [
      "settings.tab.bedrockApiKey",
      "settings.tab.awsAccessKeyId",
      "settings.tab.awsSecretAccessKey",
      "settings.tab.awsRegion",
    ]) {
      expect(within(chat).getByText(label)).toBeInTheDocument();
    }
    expect(within(chat).getByText("settings.tab.awsFallbackNote")).toBeInTheDocument();
    expect(within(chat).getByText("settings.role.ready")).toBeInTheDocument();
    // The embedder is still OpenAI, so its key sits in the Embedding block.
    expect(within(chat).queryByText("settings.tab.openaiKey")).not.toBeInTheDocument();
    expect(within(roleBlock("settings.role.embed.title")).getByText("settings.tab.openaiKey")).toBeInTheDocument();
  });

  it("lists stored keys that no task uses, with a way to remove them", async () => {
    mockSecretsList.mockResolvedValue({
      secrets: [
        { key: "openai_api_key", configured: true },
        { key: "nebius_api_key", configured: true },
      ],
    });
    renderWithProvider(<SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="model" />);

    await waitFor(() => expect(screen.getByText("settings.tab.unusedKeys")).toBeInTheDocument());
    const unused = screen.getByText("settings.tab.unusedKeys").closest("section") as HTMLElement;
    expect(within(unused).getByText("settings.tab.nebiusKey")).toBeInTheDocument();
    expect(within(unused).queryByText("settings.tab.openaiKey")).not.toBeInTheDocument();
    expect(within(unused).getByRole("button", { name: "common.delete" })).toBeInTheDocument();
  });

  // LangSmith's key sits beside the tracing switch (`langsmith-card.tsx`).
  it("leaves the LangSmith key to the card that owns the switch", async () => {
    renderWithProvider(<SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="model" />);

    await waitFor(() => expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument());
    expect(screen.queryByText("settings.tab.langsmithApiKey")).not.toBeInTheDocument();
  });

  it("reports a key set nowhere as not configured", async () => {
    mockSecretsList.mockResolvedValue({ secrets: [{ key: "openai_api_key", configured: false }] });

    renderWithProvider(<SettingsTab instance={makeInstance({ provider: "openai" })} onUpdate={onUpdate} section="model" />);

    await waitFor(() => expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument());
    const chat = roleBlock("settings.role.chat.title");
    expect(within(chat).getByText("settings.tab.notConfigured")).toBeInTheDocument();
    expect(within(chat).getByText("settings.role.missing")).toBeInTheDocument();
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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
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

  it("offers every embedder the server serves, including one it has never heard of", async () => {
    // The regression this pins: the select used to render two hardcoded options,
    // so an embedder registered at boot could be reached only by a direct PATCH.
    // The id is deliberately not one this file knows: what is being asserted is
    // that the panel keeps no list of its own.
    const user = userEvent.setup();
    mockModelsList.mockResolvedValue({
      providers: {
        openai: { models: [{ id: "gpt-4o", tier: "standard", costInput: 0.01, costOutput: 0.03, supportsThinking: false, supportsTemperature: true }] },
      },
      embedders: [
        { id: "openai", supportedDims: [1024, 1536] },
        { id: "some-registered-embedder", supportedDims: [1024] },
      ],
    });

    renderWithProvider(<SettingsTab instance={makeInstance()} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });

    const embedderTrigger = screen.getByRole("combobox", { name: "settings.tab.embedder" });
    embedderTrigger.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("option", { name: /some-registered-embedder/i })).toBeInTheDocument();
  });

  it("keeps the agent's current embedder selectable when the server stops offering it", async () => {
    // A blank select would save a silent change on the next submit, and that
    // change wipes memories and knowledge.
    mockModelsList.mockResolvedValue({
      providers: {
        openai: { models: [{ id: "gpt-4o", tier: "standard", costInput: 0.01, costOutput: 0.03, supportsThinking: false, supportsTemperature: true }] },
      },
      embedders: [{ id: "openai", supportedDims: [1024, 1536] }],
    });

    renderWithProvider(
      <SettingsTab
        instance={makeInstance({ embeddingProvider: "an-embedder-no-longer-served" })}
        onUpdate={onUpdate}
        section="model"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });

    const embedderTrigger = screen.getByRole("combobox", { name: "settings.tab.embedder" });
    expect(embedderTrigger).toHaveTextContent(/an-embedder-no-longer-served/i);
  });

  it("does not prompt for a wipe when the embedding provider is unchanged (openai→anthropic)", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ provider: "openai", model: "gpt-4o", memoryEnabled: true });
    const updatedInstance = makeInstance({ provider: "anthropic", model: "claude-3-opus" });
    mockInstanceUpdate.mockResolvedValueOnce({ instance: updatedInstance });
    // Anthropic's key is stored, so switching to it does not block the save.
    mockSecretsList.mockResolvedValue({
      secrets: [
        { key: "openai_api_key", configured: true },
        { key: "anthropic_api_key", configured: true },
      ],
    });

    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
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

  it("selects the disabled STT provider and includes it in the save payload", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ sttProvider: "openai" });
    const updatedInstance = makeInstance({ sttProvider: "disabled" });
    mockInstanceUpdate.mockResolvedValueOnce({ instance: updatedInstance });

    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });

    expect(screen.queryByText("common.save")).not.toBeInTheDocument();

    const sttTrigger = screen.getByRole("combobox", { name: "settings.tab.sttProvider" });
    sttTrigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "settings.tab.sttProviderDisabled" }));

    await user.click(screen.getByText("common.save"));

    await waitFor(() => {
      expect(mockInstanceUpdate).toHaveBeenCalledWith(
        "test-instance",
        expect.objectContaining({ sttProvider: "disabled" }),
      );
    });
  });

  it("saves secrets when api key fields are filled", async () => {
    const user = userEvent.setup();
    const instance = makeInstance();
    const onConfigurationChanged = vi.fn();

    mockSecretsSet.mockResolvedValueOnce({
      secrets: [{ key: "openai_api_key", configured: true }],
    });
    mockInstanceUpdate.mockResolvedValueOnce({ instance });

    renderWithProvider(
      <SettingsTab
        instance={instance}
        onUpdate={onUpdate}
        section="model"
        onConfigurationChanged={onConfigurationChanged}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("settings.tab.openaiKey")).toBeInTheDocument();
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
    expect(onConfigurationChanged).toHaveBeenCalledTimes(1);
  });

  it("shows error toast on save failure", async () => {
    const user = userEvent.setup();
    const instance = makeInstance({ memoryEnabled: false });
    mockInstanceUpdate.mockRejectedValueOnce(new Error("Server error"));

    renderWithProvider(<SettingsTab instance={instance} onUpdate={onUpdate} section="model" />);

    await waitFor(() => {
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });
    await openTuning();

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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });
    await openTuning();

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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });
    await openTuning();

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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });
    await openTuning();

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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });
    await openTuning();

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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });
    await openTuning();

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
      expect(screen.getByText("settings.role.chat.title")).toBeInTheDocument();
    });
    await openTuning();

    // gpt-oss reasons on every call: the UI states it (hint) instead of a working
    // off switch, and the toggle is locked ON + disabled.
    expect(screen.getByText("settings.tab.thinkingAlwaysOn")).toBeInTheDocument();

    const thinkingBlock = screen.getByText("settings.tab.thinking").closest("div.flex");
    const toggle = within(thinkingBlock as HTMLElement).getByRole("switch");
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
  });
});
