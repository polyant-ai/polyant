// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmbedOptions, EmbeddingResult } from "./types.js";
import { embedOpenAI, embedManyOpenAI } from "./providers/openai.js";
import { embedBedrock, embedManyBedrock } from "./providers/bedrock.js";
import { embedCompatible, embedManyCompatible } from "./providers/openai-compatible.js";
import { getEmbeddingProvider } from "./registry.js";
import { EMBEDDING_MODEL_IDS } from "./config.js";
import { aiLogger } from "../ai-gateway/logger.js";
import { estimateEmbeddingCost } from "../ai-gateway/config.js";
import { asInstanceSlug } from "../instances/identifiers.js";

export async function embed(text: string, opts: EmbedOptions): Promise<number[]> {
  const startedAt = Date.now();
  const { credentials, dimensions } = opts;
  let result: EmbeddingResult;
  if (credentials.provider === "openai") {
    result = await embedOpenAI(text, { apiKey: credentials.apiKey, dimensions });
  } else if (credentials.provider === "openai-compatible") {
    result = await embedCompatible(text, {
      registration: requireRegistration(credentials.name),
      apiKey: credentials.apiKey,
      dimensions,
    });
  } else {
    result = await embedBedrock(text, {
      apiKey: credentials.apiKey,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      region: credentials.region,
      dimensions,
    });
  }
  logEmbeddingCall(opts, result.tokens, Date.now() - startedAt);
  return result.embeddings[0];
}

export async function embedMany(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  const startedAt = Date.now();
  const { credentials, dimensions } = opts;
  let result: EmbeddingResult;
  if (credentials.provider === "openai") {
    result = await embedManyOpenAI(texts, { apiKey: credentials.apiKey, dimensions });
  } else if (credentials.provider === "openai-compatible") {
    result = await embedManyCompatible(texts, {
      registration: requireRegistration(credentials.name),
      apiKey: credentials.apiKey,
      dimensions,
    });
  } else {
    result = await embedManyBedrock(texts, {
      apiKey: credentials.apiKey,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      region: credentials.region,
      dimensions,
    });
  }
  logEmbeddingCall(opts, result.tokens, Date.now() - startedAt);
  return result.embeddings;
}

/** The model an embedding call ran on, as its price is keyed. */
function embeddingModelId(opts: EmbedOptions): string {
  const { credentials } = opts;
  if (credentials.provider === "openai-compatible") return getEmbeddingProvider(credentials.name)?.modelId ?? credentials.name;
  return EMBEDDING_MODEL_IDS[credentials.provider];
}

/**
 * Log an embedding call to `ai_logs` as an `embedding` call of its agent.
 *
 * Embeddings go to the provider through the AI SDK directly, not through the
 * chat gateway, so they used to leave no row: knowledge ingestion, memory
 * extraction and every retrieval were billed by the provider and missing from
 * every cost total. Its own call type keeps it out of the call counts and
 * response times, which measure model calls. A call made for no agent (no
 * `instanceSlug`) has no total to land in and is not logged.
 */
function logEmbeddingCall(opts: EmbedOptions, tokens: number, durationMs: number): void {
  if (!opts.instanceSlug) return;
  const model = embeddingModelId(opts);
  aiLogger.log(
    aiLogger.createEntry(
      opts.providerName,
      model,
      "fast",
      false,
      tokens,
      0,
      tokens,
      estimateEmbeddingCost(opts.providerName, model, tokens),
      durationMs,
      0,
      0,
      undefined,
      asInstanceSlug(opts.instanceSlug),
      "embedding",
    ),
  );
}

/**
 * The registration behind a resolved compatible credential. It was present when
 * the credential was built, so its absence here means the registry was rebuilt
 * mid-flight — worth an explicit throw rather than a call to an undefined base URL.
 */
function requireRegistration(name: string) {
  const registration = getEmbeddingProvider(name);
  if (!registration) {
    throw new Error(`Embedding provider "${name}" is not registered in this deployment.`);
  }
  return registration;
}

export type {
  EmbeddingProvider,
  EmbeddingCredentials,
  EmbedOptions,
  EmbeddingContext,
  EmbeddingDim,
  OpenAICredentials,
  BedrockCredentials,
  CompatibleEmbeddingCredentials,
} from "./types.js";

export { resolveEmbeddingContext } from "./provider-resolver.js";
export { registerEmbeddingProvider, getEmbeddingProvider, registeredEmbeddingProviderNames } from "./registry.js";
export type { EmbeddingProviderRegistration } from "./registry.js";
