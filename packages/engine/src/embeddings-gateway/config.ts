import type { EmbeddingProvider, EmbeddingDim } from "./types.js";

/** Model ID per provider. Both must support 1024-dim output. */
export const EMBEDDING_MODEL_IDS: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
  bedrock: "amazon.titan-embed-text-v2:0",
};

/** Dimensions supported per provider. Titan v2 cannot emit 1536-dim. */
export const SUPPORTED_DIMS: Record<EmbeddingProvider, readonly EmbeddingDim[]> = {
  openai: [1024, 1536],
  bedrock: [1024],
};

/** Default dimension for brand-new instances. */
export const DEFAULT_EMBEDDING_DIM: EmbeddingDim = 1024;

export function assertDimSupported(
  provider: EmbeddingProvider,
  dim: EmbeddingDim,
): void {
  if (!SUPPORTED_DIMS[provider].includes(dim)) {
    throw new Error(
      `Embedding provider "${provider}" does not support ${dim}-dim output. Supported: ${SUPPORTED_DIMS[provider].join(", ")}.`,
    );
  }
}
