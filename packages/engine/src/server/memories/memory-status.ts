// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Instance } from "../../instances/store.js";
import { findInstanceByIdOrSlug } from "../../instances/resolve-instance-id.js";
import { getAllSecretsById, SECRET_KEYS } from "../../instances/secrets.store.js";
import { SUPPORTED_DIMS } from "../../embeddings-gateway/config.js";
import type { EmbeddingDim, EmbeddingProvider } from "../../embeddings-gateway/types.js";

/**
 * Embedding-pipeline readiness for an instance's memory feature.
 * - `needsOpenAIKey`: memory is ON but the configured embedding path is unusable.
 * - `canEnable`: the embedding pipeline is ready.
 * Memory OFF always reports both false (no banner).
 */
export interface MemoryStatus {
  readonly needsOpenAIKey: boolean;
  readonly canEnable: boolean;
}

const OFF: MemoryStatus = { needsOpenAIKey: false, canEnable: false };

/** Core logic given a loaded Instance (avoids a second DB round trip). */
export async function computeMemoryStatusFromInstance(instance: Instance): Promise<MemoryStatus> {
  if (!instance.memoryEnabled) return OFF;
  const secrets = await getAllSecretsById(instance.id);
  // Embedding provider is an independent field (decoupled from the chat provider).
  const embeddingProvider: EmbeddingProvider = instance.embeddingProvider;

  // The instance is only usable if the embedding provider can emit its stored
  // dimension. A provider switch that left embedding_dim incompatible (e.g.
  // bedrock + 1536) makes every embed throw — never report that as healthy.
  const dimCompatible = SUPPORTED_DIMS[embeddingProvider].includes(instance.embeddingDim as EmbeddingDim);

  if (embeddingProvider === "bedrock") {
    // CONVENTION-EXCEPTION: process.env.AWS_REGION read directly to mirror the
    // engine-level fallback in resolveEmbeddingContext — otherwise the UI reports
    // "AWS credentials needed" while embeddings actually work via the engine region.
    const hasRegion = !!secrets[SECRET_KEYS.AWS_REGION] || !!process.env.AWS_REGION;
    return { needsOpenAIKey: !hasRegion, canEnable: hasRegion && dimCompatible };
  }
  const hasOpenAIKey = !!secrets[SECRET_KEYS.OPENAI_API_KEY];
  return { needsOpenAIKey: !hasOpenAIKey, canEnable: hasOpenAIKey && dimCompatible };
}

/** Derive memory embedding status by instance id or slug. */
export async function computeMemoryStatus(instanceIdOrSlug: string): Promise<MemoryStatus> {
  const instance = await findInstanceByIdOrSlug(instanceIdOrSlug);
  if (!instance) return OFF;
  return computeMemoryStatusFromInstance(instance);
}
