// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmbedOptions } from "./types.js";
import { embedOpenAI, embedManyOpenAI } from "./providers/openai.js";
import { embedBedrock, embedManyBedrock } from "./providers/bedrock.js";
import { embedCompatible, embedManyCompatible } from "./providers/openai-compatible.js";
import { getEmbeddingProvider } from "./registry.js";

export async function embed(text: string, opts: EmbedOptions): Promise<number[]> {
  const { credentials, dimensions } = opts;
  if (credentials.provider === "openai") {
    return embedOpenAI(text, { apiKey: credentials.apiKey, dimensions });
  }
  if (credentials.provider === "openai-compatible") {
    return embedCompatible(text, {
      registration: requireRegistration(credentials.name),
      apiKey: credentials.apiKey,
      dimensions,
    });
  }
  return embedBedrock(text, {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    dimensions,
  });
}

export async function embedMany(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const { credentials, dimensions } = opts;
  if (credentials.provider === "openai") {
    return embedManyOpenAI(texts, { apiKey: credentials.apiKey, dimensions });
  }
  if (credentials.provider === "openai-compatible") {
    return embedManyCompatible(texts, {
      registration: requireRegistration(credentials.name),
      apiKey: credentials.apiKey,
      dimensions,
    });
  }
  return embedManyBedrock(texts, {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    dimensions,
  });
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
