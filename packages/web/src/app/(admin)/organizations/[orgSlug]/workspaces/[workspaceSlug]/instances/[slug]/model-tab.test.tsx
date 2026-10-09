// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent's Model section: one row per task, each opening a side panel where
 * its provider, model, options and key are chosen and saved together.
 *
 * Pinned: the rows say what each task uses and whether its key is in place; a
 * panel writes nothing before its Save and is not "changed" until something
 * is; a key typed in the panel is saved before the choice that needs it; a
 * provider whose key is missing cannot be saved; the embedder switch that
 * wipes memories and knowledge is confirmed; a reader who cannot see the keys
 * is never asked for one.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Instance } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  models: vi.fn(),
  secretsList: vi.fn(),
  secretsSet: vi.fn(),
  secretsDelete: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const { MockApiError } = vi.hoisted(() => ({
  MockApiError: class ApiError extends Error {
    status?: number;
  },
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(",")}` : key,
    locale: "en",
    setLocale: vi.fn(),
  })),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

vi.mock("@/lib/api", () => ({
  api: {
    instances: { update: mocks.update },
    models: { list: mocks.models },
    secrets: { list: mocks.secretsList, set: mocks.secretsSet, delete: mocks.secretsDelete },
  },
  ApiError: MockApiError,
  isForbidden: (err: unknown) => err instanceof MockApiError && err.status === 403,
  getUserErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

import { ModelTab } from "./model-tab";

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
    attachmentStorageEnabled: false,
    optoutEnabled: false,
    optoutStopKeywords: [],
    optoutResumeKeywords: [],
    optoutClosingMessage: null,
    optoutResumeMessage: null,
    optoutInjectPromptHint: false,
    webContextFieldMapping: {},
    sttProvider: "openai",
    icon: null,
    temperature: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}


const MODELS = {
  providers: {
    openai: {
      models: [
        { id: "gpt-4o", tier: "standard", costInput: 0.01, costOutput: 0.03, supportsThinking: false, supportsTemperature: true },
        { id: "o3", tier: "heavy", costInput: 0.01, costOutput: 0.03, supportsThinking: true, supportsTemperature: false },
      ],
    },
    anthropic: { models: [{ id: "claude-3-opus", tier: "heavy", costInput: 0.015, costOutput: 0.075, supportsThinking: false, supportsTemperature: true }] },
    bedrock: { models: [{ id: "titan", tier: "standard", costInput: 0.01, costOutput: 0.03, supportsThinking: false, supportsTemperature: true }] },
  },
  // The embedder select renders from THIS list, never from a copy in the component.
  embedders: [
    { id: "openai", supportedDims: [1024, 1536] },
    { id: "bedrock", supportedDims: [1024] },
  ],
};

const STORED = [
  { key: "openai_api_key", configured: true },
  { key: "anthropic_api_key", configured: false },
];

/** The task's row, by its title. */
const row = async (title: string) => (await screen.findByRole("button", { name: `modelTasks.open:${title}` })).closest("tr")!;

async function openTask(title: string) {
  await userEvent.click(await screen.findByRole("button", { name: `modelTasks.open:${title}` }));
  return screen.findByRole("dialog");
}

/** Pick an option of a Radix select inside the panel, by the select's label. */
async function pick(panel: HTMLElement, label: string, option: string | RegExp) {
  const user = userEvent.setup();
  const trigger = within(panel).getByRole("combobox", { name: label });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("ModelTab", () => {
  const onUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.models.mockResolvedValue(MODELS);
    mocks.secretsList.mockResolvedValue({ secrets: STORED });
    mocks.secretsSet.mockImplementation(async (_slug: string, entries: { key: string }[]) => ({
      secrets: [...STORED.filter((s) => !entries.some((e) => e.key === s.key)), ...entries.map((e) => ({ key: e.key, configured: true }))],
    }));
    mocks.update.mockImplementation(async (_slug: string, body: Partial<Instance>) => ({ instance: makeInstance(body) }));
  });

  it("lists each task with its provider, model and whether its key is in place", async () => {
    render(<ModelTab instance={makeInstance({ knowledgeEnabled: false, memoryEnabled: false })} onUpdate={onUpdate} />);

    const chat = await row("settings.role.chat.title");
    expect(chat).toHaveTextContent("OpenAI");
    expect(chat).toHaveTextContent("gpt-4o");
    expect(chat).toHaveTextContent("settings.role.ready");
    // Memory and knowledge off: the embedder runs for nothing.
    expect(await row("settings.role.embed.title")).toHaveTextContent("modelTasks.notInUse");
    expect(await row("settings.role.stt.title")).toHaveTextContent("OpenAI Whisper");
  });

  it("says a task's key is missing when its provider's key is not stored", async () => {
    render(<ModelTab instance={makeInstance({ provider: "anthropic", model: "claude-3-opus", effectiveProvider: "anthropic" })} onUpdate={onUpdate} />);

    expect(await row("settings.role.chat.title")).toHaveTextContent("settings.role.missing");
  });

  it("opens a task with nothing to save until something changes", async () => {
    render(<ModelTab instance={makeInstance()} onUpdate={onUpdate} />);

    const panel = await openTask("settings.role.chat.title");
    expect(within(panel).getByRole("button", { name: "common.save" })).toBeDisabled();
    await userEvent.click(within(panel).getByRole("button", { name: "common.cancel" }));
    // Nothing changed: the panel closes without asking to discard anything.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("saves the conversation's model from its panel", async () => {
    render(<ModelTab instance={makeInstance()} onUpdate={onUpdate} />);

    const panel = await openTask("settings.role.chat.title");
    await pick(panel, "settings.tab.model", "o3");
    await userEvent.click(within(panel).getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("test-instance", expect.objectContaining({ provider: "openai", model: "o3" })),
    );
    expect(mocks.secretsSet).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it("blocks a provider without its key, and saves the key before the choice that needs it", async () => {
    render(<ModelTab instance={makeInstance()} onUpdate={onUpdate} />);

    const panel = await openTask("settings.role.chat.title");
    await pick(panel, "settings.tab.provider", "Anthropic");
    expect(within(panel).getByText("modelTasks.keyRequired")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "common.save" })).toBeDisabled();

    await userEvent.type(within(panel).getByPlaceholderText("settings.tab.keyPlaceholder"), "test-anthropic-key");
    await userEvent.click(within(panel).getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.secretsSet).toHaveBeenCalledWith("test-instance", [{ key: "anthropic_api_key", value: "test-anthropic-key" }]);
    expect(mocks.secretsSet.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
    expect(mocks.update).toHaveBeenCalledWith("test-instance", expect.objectContaining({ provider: "anthropic" }));
  });

  it("confirms the embedder switch that wipes memories and knowledge", async () => {
    render(<ModelTab instance={makeInstance()} onUpdate={onUpdate} />);

    const panel = await openTask("settings.role.embed.title");
    await pick(panel, "settings.tab.embedder", /Bedrock/);
    await userEvent.click(within(panel).getByRole("button", { name: "common.save" }));

    expect(mocks.update).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "memory.wipe.primary" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("test-instance", { embeddingProvider: "bedrock", confirmWipe: true }),
    );
  });

  it("switches voice-note transcription off, with no key to ask for", async () => {
    render(<ModelTab instance={makeInstance()} onUpdate={onUpdate} />);

    const panel = await openTask("settings.role.stt.title");
    await pick(panel, "settings.tab.sttProvider", "settings.tab.sttProviderDisabled");
    expect(within(panel).queryByPlaceholderText(/settings.tab.keyPlaceholder/)).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("test-instance", { sttProvider: "disabled" }));
  });

  it("shows a reader who cannot see the keys the choices, and asks for no key", async () => {
    mocks.secretsList.mockRejectedValue(Object.assign(new MockApiError("forbidden"), { status: 403 }));
    render(<ModelTab instance={makeInstance({ provider: "anthropic", effectiveProvider: "anthropic" })} onUpdate={onUpdate} />);

    // Unknown is not missing.
    expect(await row("settings.role.chat.title")).not.toHaveTextContent("settings.role.missing");
    const panel = await openTask("settings.role.chat.title");
    expect(within(panel).getByText("settings.tab.credentialNoAccess")).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("disables the temperature for a model that does not take one", async () => {
    render(<ModelTab instance={makeInstance({ model: "o3" })} onUpdate={onUpdate} />);

    const panel = await openTask("settings.role.chat.title");
    expect(within(panel).getByLabelText("settings.temperature.label")).toBeDisabled();
  });
});
