// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Instance } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n/types";
import { PROVIDER_SECRET_SECTIONS, SECRET_KEYS, type ProviderSecretSection, type ProviderSectionId } from "@/lib/provider-secrets";

/** The tasks the agent calls a provider for, in the order the Model page lists them. */
export type ModelTask = "chat" | "embed" | "stt";
export const MODEL_TASKS: readonly ModelTask[] = ["chat", "embed", "stt"];

export const TASK_TITLE: Record<ModelTask, TranslationKey> = {
  chat: "settings.role.chat.title",
  embed: "settings.role.embed.title",
  stt: "settings.role.stt.title",
};

export const TASK_HELP: Record<ModelTask, TranslationKey> = {
  chat: "settings.role.chat.help",
  embed: "modelTasks.embeddingHelp",
  stt: "settings.tab.sttHelp",
};

export type STTProvider = "openai" | "aws" | "deepgram" | "disabled";

/** Voice-note transcription engines, by the product name a reader knows. */
export const STT_LABELS: Record<Exclude<STTProvider, "disabled">, string> = {
  openai: "OpenAI Whisper",
  aws: "Amazon Transcribe",
  deepgram: "Deepgram",
};

// Display labels for reasoning-effort levels (values come from the model's
// live-verified reasoningLevels set exposed by /api/instances/models).
export const REASONING_LEVEL_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** A credential set: a provider section, or Deepgram's single key. */
export type CredentialGroup = Exclude<ProviderSectionId, "langsmith"> | "deepgram";

const DEEPGRAM_SECTION: ProviderSecretSection & { id: "deepgram" } = {
  id: "deepgram" as never,
  titleKey: "settings.tab.deepgramKey",
  fields: [{ key: SECRET_KEYS.DEEPGRAM, labelKey: "settings.tab.deepgramKey" }],
} as ProviderSecretSection & { id: "deepgram" };

export function credentialSection(group: CredentialGroup): ProviderSecretSection {
  return group === "deepgram" ? DEEPGRAM_SECTION : PROVIDER_SECRET_SECTIONS.find((s) => s.id === group)!;
}

/**
 * Which credential set a task's provider reads. A provider registered at boot is
 * absent: the panel does not know its keys, and says so instead of guessing.
 */
const CHAT_CREDENTIAL: Record<string, CredentialGroup> = { openai: "openai", anthropic: "anthropic", nebius: "nebius", bedrock: "aws" };
const EMBEDDER_CREDENTIAL: Record<string, CredentialGroup> = { openai: "openai", bedrock: "aws" };
const STT_CREDENTIAL: Record<string, CredentialGroup> = { openai: "openai", aws: "aws", deepgram: "deepgram" };

/**
 * The keys a set must hold for its provider to answer. AWS needs none: Bedrock
 * and Transcribe fall back to the host's profile or IAM role, so an empty AWS
 * block is a working configuration, not a missing one.
 */
export const REQUIRED_KEYS: Record<CredentialGroup, readonly string[]> = {
  openai: [SECRET_KEYS.OPENAI],
  anthropic: [SECRET_KEYS.ANTHROPIC],
  nebius: [SECRET_KEYS.NEBIUS],
  aws: [],
  deepgram: [SECRET_KEYS.DEEPGRAM],
};

/** The providers each task is set to, saved or drafted. */
export interface TaskChoices {
  chatProvider: string;
  embeddingProvider: string;
  sttProvider: STTProvider;
}

export function savedChoices(instance: Instance): TaskChoices {
  return {
    chatProvider: instance.provider || instance.effectiveProvider || "",
    embeddingProvider: instance.embeddingProvider ?? "openai",
    sttProvider: (instance.sttProvider as STTProvider | null) ?? "openai",
  };
}

/** The credential set a task reads under these choices; null when it reads none the panel knows. */
export function taskCredential(task: ModelTask, choices: TaskChoices): CredentialGroup | null {
  switch (task) {
    case "chat":
      return CHAT_CREDENTIAL[choices.chatProvider] ?? null;
    case "embed":
      return EMBEDDER_CREDENTIAL[choices.embeddingProvider] ?? null;
    case "stt":
      return choices.sttProvider === "disabled" ? null : (STT_CREDENTIAL[choices.sttProvider] ?? null);
  }
}

/** Embeddings matter only while memory or knowledge is on; transcription unless switched off. */
export function taskInUse(task: ModelTask, instance: Instance, sttProvider: STTProvider): boolean {
  if (task === "stt") return sttProvider !== "disabled";
  if (task === "embed") return instance.memoryEnabled || instance.knowledgeEnabled;
  return true;
}
