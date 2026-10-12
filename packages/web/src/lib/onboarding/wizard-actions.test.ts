// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the wizard writes, and in which order. The order is the point: a provider
 * saved without its key fails at the first message, and Web switched on before
 * its key exists answers every caller with 401.
 */

const calls = vi.hoisted(() => [] as string[]);
const h = vi.hoisted(() => ({
  create: vi.fn(),
  secrets: vi.fn(),
  update: vi.fn(),
  prompts: vi.fn(),
  channels: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    instances: {
      create: (...a: unknown[]) => (calls.push("create"), h.create(...a)),
      update: (...a: unknown[]) => (calls.push("update"), h.update(...a)),
    },
    secrets: { set: (...a: unknown[]) => (calls.push("secrets"), h.secrets(...a)) },
    prompts: { update: (...a: unknown[]) => (calls.push("prompts"), h.prompts(...a)) },
    channels: { set: (...a: unknown[]) => (calls.push("channels"), h.channels(...a)) },
    knowledge: { upload: (...a: unknown[]) => (calls.push("upload"), h.upload(...a)) },
  },
}));

import {
  EMPTY_DRAFT,
  applyProviderConfig,
  createAgentFromDraft,
  enableWebWithKey,
  toSlug,
  typedKeys,
  addKnowledgeText,
} from "./wizard-actions";

const draft = {
  ...EMPTY_DRAFT,
  provider: "openai",
  model: "gpt-x",
  keys: { openai_api_key: " sk-test ", anthropic_api_key: "sk-other" },
  name: "Support bot",
  slug: "support-bot",
  description: "  Helps  ",
  instructions: "  Be brief.  ",
};

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  h.create.mockResolvedValue({ instance: { slug: "support-bot", name: "Support bot" } });
  for (const m of [h.secrets, h.update, h.prompts, h.channels, h.upload]) m.mockResolvedValue({});
});

describe("collected key", () => {
  it("keeps only the chosen provider's fields, trimmed", () => {
    expect(typedKeys(draft)).toEqual([{ key: "openai_api_key", value: "sk-test" }]);
  });

  it("ignores empty values", () => {
    expect(typedKeys({ ...draft, keys: { openai_api_key: "  " } })).toEqual([]);
  });
});

describe("creating the agent", () => {
  it("creates with provider and model, then stores the key and the instructions", async () => {
    const out = await createAgentFromDraft(draft);
    expect(h.create).toHaveBeenCalledWith({
      name: "Support bot",
      slug: "support-bot",
      description: "Helps",
      provider: "openai",
      model: "gpt-x",
    });
    expect(h.secrets).toHaveBeenCalledWith("support-bot", [{ key: "openai_api_key", value: "sk-test" }]);
    expect(h.prompts).toHaveBeenCalledWith("support-bot", [{ key: "01-identity", content: "Be brief." }]);
    expect(calls).toEqual(["create", "secrets", "prompts"]);
    expect(out.applied).toEqual({ keysSaved: true, modelSaved: true });
  });

  it("leaves provider, key and prompt alone when nothing was collected", async () => {
    const out = await createAgentFromDraft({ ...EMPTY_DRAFT, name: "A", slug: "a" });
    expect(h.create).toHaveBeenCalledWith({ name: "A", slug: "a", description: undefined });
    expect(calls).toEqual(["create"]);
    expect(out.applied).toEqual({ keysSaved: false, modelSaved: false });
  });

  it("applies a key and model chosen after the agent exists, key first", async () => {
    await applyProviderConfig("support-bot", draft);
    expect(calls).toEqual(["secrets", "update"]);
    expect(h.update).toHaveBeenCalledWith("support-bot", { provider: "openai", model: "gpt-x" });
  });
});

describe("turning Web on", () => {
  it("writes the key, then authentication, then the channel, and returns the key once", async () => {
    const key = await enableWebWithKey("support-bot");
    expect(calls).toEqual(["secrets", "update", "channels"]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(h.secrets).toHaveBeenCalledWith("support-bot", [{ key: "auth_api_key", value: key }]);
    expect(h.update).toHaveBeenCalledWith("support-bot", { authEnabled: true });
    expect(h.channels).toHaveBeenCalledWith("support-bot", "web", {}, true);
  });

  it("does not switch the channel on when the key could not be saved", async () => {
    h.secrets.mockRejectedValue(new Error("boom"));
    await expect(enableWebWithKey("support-bot")).rejects.toThrow("boom");
    expect(h.channels).not.toHaveBeenCalled();
  });
});

describe("knowledge and slugs", () => {
  it("turns knowledge on before uploading the text", async () => {
    await addKnowledgeText("support-bot", "Hours", " Open 9-5 ");
    expect(calls).toEqual(["update", "upload"]);
    expect(h.upload).toHaveBeenCalledWith("support-bot", { filename: "Hours.md", content: "Open 9-5" });
  });

  it("builds a slug from a name with accents and symbols", () => {
    expect(toSlug("  Assistente Vendite è Più! ")).toBe("assistente-vendite-e-piu");
  });
});
