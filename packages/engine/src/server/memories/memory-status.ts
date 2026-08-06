// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Instance } from "../../instances/store.js";
import { findInstanceByIdOrSlug } from "../../instances/resolve-agent-id.js";
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

/**
 * Whether the embedder itself is usable, INDEPENDENT of which feature wants it.
 *
 * Memory and knowledge share one embedder, but readiness used to be computed only
 * inside the memory gate — so an agent using knowledge and no memory reported
 * `needsOpenAIKey: false` no matter what, and the panel had nothing to warn on.
 * The visible symptom was an admin enabling document retrieval, getting a green
 * toast, uploading, and every document landing in `status: error` with no hint
 * that the embedder had no credentials.
 *
 * This is the single reader of that rule; `computeMemoryStatusFromInstance` and
 * the knowledge banner both go through it rather than keeping a copy.
 */
export interface EmbedderReadiness {
  readonly hasCredentials: boolean;
  readonly dimCompatible: boolean;
}

export async function computeEmbedderReadiness(instance: Instance): Promise<EmbedderReadiness> {
  const secrets = await getAllSecretsById(instance.id);
  // Embedding provider is an independent field (decoupled from the chat provider).
  const embeddingProvider: EmbeddingProvider = instance.embeddingProvider;

  // The instance is only usable if the embedding provider can emit its stored
  // dimension. A provider switch that left embedding_dim incompatible (e.g.
  // bedrock + 1536) makes every embed throw — never report that as healthy.
  const dimCompatible = SUPPORTED_DIMS[embeddingProvider].includes(
    instance.embeddingDim as EmbeddingDim,
  );

  if (embeddingProvider === "bedrock") {
    // CONVENTION-EXCEPTION: process.env.AWS_REGION read directly to mirror the
    // engine-level fallback in resolveEmbeddingContext — otherwise the UI reports
    // "AWS credentials needed" while embeddings actually work via the engine region.
    const hasRegion = !!secrets[SECRET_KEYS.AWS_PROVIDER_REGION] || !!process.env.AWS_REGION;
    return { hasCredentials: hasRegion, dimCompatible };
  }
  return { hasCredentials: !!secrets[SECRET_KEYS.OPENAI_API_KEY], dimCompatible };
}

/**
 * The embedder's readiness as the admin panel needs it, unconditioned on any
 * feature flag — so the Knowledge tab can warn about missing credentials for an
 * agent that has memory switched off.
 *
 * Reported from the ENGINE rather than recomputed in the browser on purpose: the
 * client cannot see the `AWS_REGION` env fallback, so a client-side copy of this
 * rule shows a false "AWS credentials needed" on a bedrock instance that embeds
 * perfectly well through the engine's region.
 */
export interface EmbedderStatus {
  readonly needsCredentials: boolean;
}

export async function computeEmbedderStatus(instance: Instance): Promise<EmbedderStatus> {
  const { hasCredentials } = await computeEmbedderReadiness(instance);
  return { needsCredentials: !hasCredentials };
}

/** Core logic given a loaded Instance (avoids a second DB round trip). */
export async function computeMemoryStatusFromInstance(instance: Instance): Promise<MemoryStatus> {
  if (!instance.memoryEnabled) return OFF;
  const { hasCredentials, dimCompatible } = await computeEmbedderReadiness(instance);
  return { needsOpenAIKey: !hasCredentials, canEnable: hasCredentials && dimCompatible };
}

/** Derive memory embedding status by instance id or slug. */
export async function computeMemoryStatus(instanceIdOrSlug: string): Promise<MemoryStatus> {
  const instance = await findInstanceByIdOrSlug(instanceIdOrSlug);
  if (!instance) return OFF;
  return computeMemoryStatusFromInstance(instance);
}
