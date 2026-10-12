// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Instance } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n/types";
import {
  credentialSection,
  taskCredential,
  REQUIRED_KEYS,
  type CredentialGroup,
  type ModelTask,
  type STTProvider,
  type TaskChoices,
} from "@/lib/provider-credentials";

// The mapping lives in lib/ so the guided setup reads the same one; re-exported so
// this page's imports keep working.
export { credentialSection, taskCredential, REQUIRED_KEYS };
export type { CredentialGroup, ModelTask, STTProvider, TaskChoices };

/** The tasks in the order the Model page lists them. */
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

export function savedChoices(instance: Instance): TaskChoices {
  return {
    chatProvider: instance.provider || instance.effectiveProvider || "",
    embeddingProvider: instance.embeddingProvider ?? "openai",
    sttProvider: (instance.sttProvider as STTProvider | null) ?? "openai",
  };
}

/** Embeddings matter only while memory or knowledge is on; transcription unless switched off. */
export function taskInUse(task: ModelTask, instance: Instance, sttProvider: STTProvider): boolean {
  if (task === "stt") return sttProvider !== "disabled";
  if (task === "embed") return instance.memoryEnabled || instance.knowledgeEnabled;
  return true;
}
