// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Instance } from "./store.js";

/**
 * The columns a caller is allowed to PATCH, and the bundle importer writes
 * (bar `embeddingProvider`). `embeddingDim` is deliberately excluded: it is owned
 * by the embedding-reset pipeline (set when the controller accepts a provider or
 * dimension change, together with the wipe) and must never be set directly, or
 * it desyncs from the actual populated vector column.
 *
 * The runtime whitelist `updateInstance` applies, and the one list the patch
 * type below is derived from. A column added to the table is not writable until
 * it is named here: `instance-fields.test.ts` fails on a column that is neither
 * listed nor in its explicit not-updatable set, so the omission cannot go
 * unnoticed. (Six per-agent settings once reached the controller, the DTO and
 * the schema but not the list, and every PATCH of them wrote `updatedAt` and
 * nothing else.)
 */
export const UPDATABLE_INSTANCE_KEYS = [
  "name",
  "description",
  "status",
  "provider",
  "model",
  "memoryEnabled",
  "knowledgeEnabled",
  "langsmithEnabled",
  "langsmithProject",
  "authEnabled",
  "thinkingEnabled",
  "thinkingLevel",
  "temperature",
  "stateInPromptEnabled",
  "datetimeInjectionEnabled",
  "cacheEnabled",
  "cacheTtl",
  "a2aEnabled",
  "toolResultsInHistoryEnabled",
  "debugEnabled",
  "attachmentStorageEnabled",
  "icon",
  "sttProvider",
  "embeddingProvider",
  "optoutEnabled",
  "optoutStopKeywords",
  "optoutResumeKeywords",
  "optoutClosingMessage",
  "optoutResumeMessage",
  "optoutInjectPromptHint",
  "webContextFieldMapping",
  "datetimeTimezone",
  "datetimeLocale",
  "dedupSimilarityThreshold",
  "messageSoftDebounceMs",
  "messageTypingDelayMs",
  "messageMaxRestarts",
] as const satisfies readonly (keyof Instance)[];

/**
 * Fields a caller may PATCH. `embeddingProvider` changes trigger a destructive
 * wipe in the controller; `null` on the six per-agent settings is a real value —
 * it clears the column and hands the agent back to the deployment default.
 */
export type UpdatableInstanceFields = Partial<Pick<Instance, (typeof UPDATABLE_INSTANCE_KEYS)[number]>>;
