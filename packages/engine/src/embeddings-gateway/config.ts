// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmbeddingProvider, EmbeddingDim } from "./types.js";
import { getEmbeddingProvider, registeredEmbeddingProviderNames } from "./registry.js";

/** Model ID for the two built-in embedders. Both support 1024-dim output. */
export const EMBEDDING_MODEL_IDS: Record<"openai" | "bedrock", string> = {
  openai: "text-embedding-3-small",
  bedrock: "amazon.titan-embed-text-v2:0",
};

/** Dimensions supported by the two built-ins. Titan v2 cannot emit 1536-dim. */
const BUILT_IN_DIMS: Record<"openai" | "bedrock", readonly EmbeddingDim[]> = {
  openai: [1024, 1536],
  bedrock: [1024],
};

/** Default dimension for brand-new instances. */
export const DEFAULT_EMBEDDING_DIM: EmbeddingDim = 1024;

/**
 * The dimensions an embedder can emit — the built-ins from the table above, a
 * registered one from its registration. Empty for a name nothing serves, which
 * is what makes an unknown provider fail every dimension check rather than
 * throwing on a missing table entry.
 */
export function supportedDimsFor(provider: EmbeddingProvider): readonly EmbeddingDim[] {
  if (provider === "openai" || provider === "bedrock") return BUILT_IN_DIMS[provider];
  return getEmbeddingProvider(provider)?.supportedDims ?? [];
}

/** Every embedder this deployment can use: the two built-ins plus registrations. */
export function knownEmbeddingProviders(): readonly EmbeddingProvider[] {
  return ["openai", "bedrock", ...registeredEmbeddingProviderNames()];
}

/** Whether a name is an embedder this deployment can actually use. */
export function isKnownEmbeddingProvider(provider: string): boolean {
  return knownEmbeddingProviders().includes(provider);
}

/**
 * Map a chat provider to its embedding provider. A provider that embeds under
 * its OWN name wins — `bedrock` → `bedrock`, and any registered embedder whose
 * name matches the chat provider, which keeps an agent's vectors with the same
 * provider as its chat when that provider serves both. Everything else
 * (openai, anthropic, and a chat provider that does not embed) → `openai`.
 *
 * That last fallback is worth saying out loud: an agent chatting on a provider
 * with no embedder of its own has its memories and knowledge embedded by OpenAI —
 * a different provider from the one the operator chose for chat, and so a
 * different place its data goes. The embedder is per-agent and settable, so the
 * operator can point it elsewhere — but nothing here does it for them.
 */
export function embeddingProviderFor(provider: string | null | undefined): EmbeddingProvider {
  if (provider === "bedrock") return "bedrock";
  if (provider && getEmbeddingProvider(provider)) return provider;
  return "openai";
}

/** Dimension a fresh embedding space should use for a provider after a wipe. */
export function defaultDimForProvider(provider: EmbeddingProvider): EmbeddingDim {
  const dims = supportedDimsFor(provider);
  return dims.includes(DEFAULT_EMBEDDING_DIM) ? DEFAULT_EMBEDDING_DIM : (dims[0] ?? DEFAULT_EMBEDDING_DIM);
}

export function assertDimSupported(
  provider: EmbeddingProvider,
  dim: EmbeddingDim,
): void {
  const dims = supportedDimsFor(provider);
  if (!dims.includes(dim)) {
    throw new Error(
      `Embedding provider "${provider}" does not support ${dim}-dim output. Supported: ${dims.join(", ") || "none"}.`,
    );
  }
}
