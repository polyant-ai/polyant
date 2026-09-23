// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmbeddingDim } from "./types.js";

/**
 * The embedders this deployment can use, beyond the two built in.
 *
 * The twin of `ai-gateway/providers/registry.ts`, and it exists for the same
 * reason: an embedder that does not ship with the engine is added without editing
 * the dispatch every embedding goes through. It also answers a question the chat
 * registry does
 * not — which DIMENSIONS an embedder can emit — because that decides which
 * vector column a row lands in, and getting it wrong is not a failed call but a
 * silently unsearchable memory.
 *
 * Registered embedders are all OpenAI-compatible `/v1/embeddings` endpoints, so
 * one shared caller serves them (`providers/openai-compatible.ts`) and a
 * registration is data: a base URL, a model id, the secret holding the key, and
 * the dimensions that model will actually return.
 */
export interface EmbeddingProviderRegistration {
  /** Provider name, as stored in `instances.embedding_provider`. */
  readonly name: string;
  /** Human-readable name, used in the missing-credential error. */
  readonly label: string;
  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  readonly baseURL: string;
  /** The embedding model id to call. */
  readonly modelId: string;
  /** The `instance_secrets` key holding the API key. */
  readonly apiKeySecret: string;
  /**
   * Dimensions this endpoint will actually return. A Matryoshka model can be
   * asked for a shorter vector through the `dimensions` param — but only where
   * the endpoint forwards it, which is exactly what this field records. An
   * endpoint that ignores `dimensions` belongs here with its NATIVE size only,
   * and if that size has no vector column it does not belong here at all.
   */
  readonly supportedDims: readonly EmbeddingDim[];
}

const registry: Record<string, EmbeddingProviderRegistration> = {};

/** Register an embedder at boot. Idempotent; refuses the two built-in names. */
export function registerEmbeddingProvider(registration: EmbeddingProviderRegistration): void {
  if (registration.name === "openai" || registration.name === "bedrock") {
    throw new Error(`Cannot register embedder "${registration.name}": the name is owned by a built-in embedder.`);
  }
  registry[registration.name] = registration;
}

/** The registration for a name, or `undefined` when nothing serves it. */
export function getEmbeddingProvider(name: string): EmbeddingProviderRegistration | undefined {
  return registry[name];
}

/** Every registered embedder name (the two built-ins are NOT included). */
export function registeredEmbeddingProviderNames(): readonly string[] {
  return Object.keys(registry);
}
