// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException } from "@nestjs/common";
import { resolveEmbeddingContext } from "../../embeddings-gateway/index.js";

/**
 * The agent's embedding context, or a 400 carrying the reason it has none.
 *
 * A write that stores something to be embedded checks this first, so an agent
 * without a configured embedder is refused up front instead of leaving a stored
 * row that can never be indexed. The gateway resolves the provider-specific
 * credentials (API key, or region for Bedrock) from the agent's slug.
 */
export function requireEmbeddingContext(
  agentSlug: Parameters<typeof resolveEmbeddingContext>[0],
): ReturnType<typeof resolveEmbeddingContext> {
  return resolveEmbeddingContext(agentSlug).catch((err: unknown) => {
    throw new BadRequestException(
      err instanceof Error ? err.message : "Embedding provider is not configured for this instance.",
    );
  });
}
