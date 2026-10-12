// SPDX-License-Identifier: AGPL-3.0-or-later

import { api, type Instance } from "@/lib/api";
import { credentialSection, taskCredential } from "@/lib/provider-credentials";
import { SECRET_KEYS } from "@/lib/provider-secrets";

/**
 * What the wizard collects before an agent exists. The agent is the only thing a
 * provider key, a model and a prompt can be saved on, so all of it is held here
 * and written the moment the agent is created.
 */
export interface WizardDraft {
  provider: string;
  /** Secret key -> typed value, for the chosen provider's credential fields. */
  keys: Record<string, string>;
  model: string;
  name: string;
  slug: string;
  slugEdited: boolean;
  description: string;
  instructions: string;
}

export const EMPTY_DRAFT: WizardDraft = {
  provider: "",
  keys: {},
  model: "",
  name: "",
  slug: "",
  slugEdited: false,
  description: "",
  instructions: "",
};

/** The prompt section the wizard's instructions go into. Defaults to empty. */
const INSTRUCTIONS_SECTION = "01-identity";

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The credential fields the chosen chat provider reads; empty when the panel does not know them. */
export function providerFields(provider: string) {
  const group = taskCredential("chat", {
    chatProvider: provider,
    embeddingProvider: "",
    sttProvider: "disabled",
  });
  return group ? credentialSection(group).fields : [];
}

/** The typed keys that belong to the CHOSEN provider; a key typed for another one is dropped. */
export function typedKeys(draft: WizardDraft): { key: string; value: string }[] {
  const allowed = new Set(providerFields(draft.provider).map((f) => f.key));
  return Object.entries(draft.keys)
    .filter(([key, value]) => allowed.has(key) && value.trim() !== "")
    .map(([key, value]) => ({ key, value: value.trim() }));
}

export interface AppliedConfig {
  keysSaved: boolean;
  modelSaved: boolean;
}

/** Writes the draft's provider key and model onto an existing agent. */
export async function applyProviderConfig(slug: string, draft: WizardDraft): Promise<AppliedConfig> {
  const keys = typedKeys(draft);
  // Keys first: a provider saved without the key it reads fails at the first message.
  if (keys.length > 0) await api.secrets.set(slug, keys);
  const modelSaved = draft.provider !== "" && draft.model !== "";
  if (modelSaved) await api.instances.update(slug, { provider: draft.provider, model: draft.model });
  return { keysSaved: keys.length > 0, modelSaved };
}

export interface CreatedAgent {
  instance: Instance;
  applied: AppliedConfig;
}

/**
 * Creates the agent with everything collected so far. New agents follow the secure
 * defaults of the engine: every channel off, Web included, and the agent key
 * required.
 */
export async function createAgentFromDraft(draft: WizardDraft): Promise<CreatedAgent> {
  const { instance } = await api.instances.create({
    name: draft.name.trim(),
    slug: draft.slug,
    description: draft.description.trim() || undefined,
    ...(draft.provider && draft.model ? { provider: draft.provider, model: draft.model } : {}),
  });
  const keys = typedKeys(draft);
  if (keys.length > 0) await api.secrets.set(instance.slug, keys);
  if (draft.instructions.trim()) {
    await api.prompts.update(instance.slug, [
      { key: INSTRUCTIONS_SECTION, content: draft.instructions.trim() },
    ]);
  }
  return {
    instance,
    applied: { keysSaved: keys.length > 0, modelSaved: !!(draft.provider && draft.model) },
  };
}

/** 256 random bits as hex, the same shape the Channels page generates. */
export function generateAgentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Turns Web on with a fresh agent key, in the order the engine accepts: the key,
 * then authentication, then the channel, so a failure never leaves Web answering
 * with nothing behind it. The key is returned once and never stored here.
 */
export async function enableWebWithKey(slug: string): Promise<string> {
  const key = generateAgentKey();
  await api.secrets.set(slug, [{ key: SECRET_KEYS.AUTH, value: key }]);
  await api.instances.update(slug, { authEnabled: true });
  await api.channels.set(slug, "web", {}, true);
  return key;
}

/** Replaces the agent key. Callers that hold the old one must be given the new one. */
export async function regenerateAgentKey(slug: string): Promise<string> {
  const key = generateAgentKey();
  await api.secrets.set(slug, [{ key: SECRET_KEYS.AUTH, value: key }]);
  return key;
}

export async function disableWeb(slug: string): Promise<void> {
  await api.channels.set(slug, "web", {}, false);
}

/** Opens or closes the agent key requirement. Enabling needs a key to exist first. */
export async function setWebAuth(slug: string, enabled: boolean): Promise<void> {
  await api.instances.update(slug, { authEnabled: enabled });
}

export async function addKnowledgeText(slug: string, title: string, text: string): Promise<void> {
  await api.instances.update(slug, { knowledgeEnabled: true });
  const base = title.trim() || "document";
  await api.knowledge.upload(slug, { filename: `${base}.md`, content: text.trim() });
}
