// SPDX-License-Identifier: AGPL-3.0-or-later

import { findInstanceBySlug, updateInstance, type Instance, type UpdatableInstanceFields } from "./store.js";
import { invalidateInstanceConfigCache } from "./config-resolver.js";
import { invalidateEmbeddingContext } from "../embeddings-gateway/provider-resolver.js";
import {
  embeddingSpaceChanged,
  nextEmbeddingDim,
  resetEmbeddingSpace,
  type EmbeddingResetResult,
} from "../embeddings-gateway/embedding-reset.service.js";
import { assertDimSupported, isKnownEmbeddingProvider, knownEmbeddingProviders } from "../embeddings-gateway/config.js";
import type { EmbeddingDim, EmbeddingProvider } from "../embeddings-gateway/types.js";
import { providerConfigs, DEFAULT_PROVIDER, clampTemperature } from "../ai-gateway/config.js";
import { countMemories } from "../memory/index.js";
import { countDocuments } from "../knowledge/index.js";

/**
 * A change to an agent's settings refused for what it asks, not for how it was
 * sent: the caller can correct it and send it again. The message is safe to
 * show the caller.
 */
export class InvalidInstanceSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInstanceSettingsError";
  }
}

/** The stored fields a PATCH writes, plus the embedding dimension and the confirmation a wipe needs. */
export type InstancePatch = UpdatableInstanceFields & { embeddingDim?: number; confirmWipe?: boolean };

/** What a PATCH will do to the agent's embedding space, decided before anything is written. */
export interface InstancePatchPlan {
  /** The embedder the agent will run on after the PATCH. */
  readonly embeddingProvider: EmbeddingProvider;
  /** The dimension the agent will embed at after the PATCH. */
  readonly embeddingDim: EmbeddingDim;
  /** True when the embedding space changes, so memories and knowledge are deleted. */
  readonly willWipe: boolean;
}

export interface InstancePatchResult {
  readonly instance: Instance;
  readonly wiped: EmbeddingResetResult | null;
}

/** Check a provider/model pair against the configured providers; `null`/absent provider is the gateway default. */
export function assertModelConfig(provider?: string | null, model?: string | null): void {
  const validProviders = Object.keys(providerConfigs);
  if (provider && !validProviders.includes(provider)) {
    throw new InvalidInstanceSettingsError(`Invalid provider "${provider}". Valid providers: ${validProviders.join(", ")}`);
  }
  if (model) {
    const effectiveProvider = provider || DEFAULT_PROVIDER;
    const cfg = providerConfigs[effectiveProvider];
    const validModels = cfg ? [...Object.values(cfg.tiers), ...Object.keys(cfg.models)] : [];
    if (!validModels.includes(model)) {
      throw new InvalidInstanceSettingsError(
        `Invalid model "${model}" for provider "${effectiveProvider}". Valid models: ${validModels.join(", ")}`,
      );
    }
  }
}

/**
 * The checks a PATCH passes without reading the agent: the embedder must be one
 * this deployment can use (the two built in plus anything registered at boot —
 * an unlisted name would be stored, then fail every embedding call), and the
 * temperature is clamped to the range the gateway sends. Returns the patch to
 * plan and write.
 */
export function normalizeInstancePatch<P extends InstancePatch>(patch: P): P {
  if (patch.embeddingProvider !== undefined && !isKnownEmbeddingProvider(patch.embeddingProvider)) {
    throw new InvalidInstanceSettingsError(
      `Invalid embeddingProvider "${patch.embeddingProvider}". Valid embedding providers: ${knownEmbeddingProviders().join(", ")}.`,
    );
  }
  if (patch.temperature === undefined) return patch;
  return { ...patch, temperature: clampTemperature(patch.temperature) };
}

/**
 * Decide what a PATCH does to an agent and refuse it before anything is
 * written when it cannot be applied as asked.
 */
export async function planInstancePatch(before: Instance, patch: InstancePatch): Promise<InstancePatchPlan> {
  // The pair the agent will run on after this PATCH is what gets checked:
  // each field from the patch when it carries one, otherwise the stored one.
  // A PATCH that changes only the model carries no provider; one that changes
  // only the provider keeps the stored model. Reading the patch alone checked a
  // model against a provider the caller never mentioned, and let a provider
  // switch keep a model of the old provider — both then failed at the first
  // message, far from this edit. `null` is a deliberate clear, so it falls
  // through to the gateway's default. A PATCH that touches neither is left
  // alone, so an older mismatched row still accepts unrelated edits.
  if (patch.provider !== undefined || patch.model !== undefined) {
    assertModelConfig(
      patch.provider !== undefined ? patch.provider : before.provider,
      patch.model !== undefined ? patch.model : before.model,
    );
  }

  // Changing the embedding provider or dimension abandons the old embedding
  // space (vectors become uninterpretable) — existing memories + knowledge are
  // wiped, never converted. Changing only the chat provider/model does NOT
  // trigger this. Require explicit confirmation when there is data to lose, so
  // a Management-API caller can't destroy it silently.
  const embeddingProvider = patch.embeddingProvider !== undefined ? patch.embeddingProvider : before.embeddingProvider;
  const embeddingDim = nextEmbeddingDim(before, embeddingProvider, patch.embeddingDim as EmbeddingDim | undefined);
  const willWipe = embeddingSpaceChanged(before, { embeddingProvider, embeddingDim });
  if (willWipe) {
    // Only a change is checked: an older row whose stored dimension its
    // provider no longer lists still accepts unrelated edits.
    try {
      assertDimSupported(embeddingProvider, embeddingDim as EmbeddingDim);
    } catch (err) {
      throw new InvalidInstanceSettingsError((err as Error).message);
    }
  }
  if (willWipe && !patch.confirmWipe) {
    const hasData = (await countMemories(before.slug)) > 0 || (await countDocuments(before.slug)) > 0;
    if (hasData) {
      throw new InvalidInstanceSettingsError(
        "Changing the embedding provider or dimension permanently deletes all memories and the entire knowledge base for this instance (existing embeddings cannot be converted). Re-send the request with confirmWipe: true to proceed.",
      );
    }
  }
  return { embeddingProvider, embeddingDim: embeddingDim as EmbeddingDim, willWipe };
}

/**
 * Write a planned PATCH: store the fields and drop the cached configuration
 * and embedding context. Returns null when the agent no longer exists. The
 * embedding space is reset by `resetPlannedEmbeddingSpace`, called after it,
 * so a caller can record the write between the two steps.
 */
export async function writeInstancePatch(before: Instance, patch: InstancePatch): Promise<Instance | null> {
  const instance = await updateInstance(before.slug, patch);
  if (!instance) return null;
  invalidateInstanceConfigCache(before.slug);
  invalidateEmbeddingContext(instance.id, before.slug);
  return instance;
}

/**
 * Reset the embedding space of an agent whose PATCH was written, when the plan
 * says the space changes, and return the row as it stands afterwards.
 */
export async function resetPlannedEmbeddingSpace(
  instance: Instance,
  plan: InstancePatchPlan,
): Promise<InstancePatchResult> {
  if (!plan.willWipe) return { instance, wiped: null };
  const wiped = await resetEmbeddingSpace(instance.slug, instance.id, plan.embeddingDim);
  // embedding_dim changed — drop the now-stale cached context and re-read the row.
  invalidateEmbeddingContext(instance.id, instance.slug);
  return { instance: (await findInstanceBySlug(instance.slug)) ?? instance, wiped };
}
