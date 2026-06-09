// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmbeddingContext, EmbeddingDim } from "./types.js";
import { findInstanceByIdOrSlug } from "../instances/resolve-instance-id.js";
import { getAllSecretsById, SECRET_KEYS } from "../instances/secrets.store.js";
import { TtlCache } from "../utils/ttl-cache.js";

function assertDim(dim: number): EmbeddingDim {
  if (dim !== 1024 && dim !== 1536) {
    throw new Error(`Unsupported instance.embedding_dim ${dim} (expected 1024 or 1536).`);
  }
  return dim;
}

// Hot-path cache keyed by the raw lookup value (id or slug); 30 s TTL matches
// config-resolver. Manual invalidation is wired into secret/instance mutations.
const cache = new TtlCache<string, EmbeddingContext>({ maxSize: 200, ttlMs: 30_000 });

/** Clear cached embedding contexts for an instance. Pass all known aliases (id and slug). */
export function invalidateEmbeddingContext(...aliases: string[]): void {
  for (const alias of aliases) {
    if (alias) cache.delete(alias);
  }
}

/** Invalidate every cached embedding context. */
export function invalidateAllEmbeddingContexts(): void {
  cache.clear();
}

/**
 * Resolve the embedding provider + credentials + dimensions for an instance.
 * Accepts either the instance UUID or slug.
 */
export async function resolveEmbeddingContext(instanceIdOrSlug: string): Promise<EmbeddingContext> {
  const cached = cache.get(instanceIdOrSlug);
  if (cached) return cached;

  const instance = await findInstanceByIdOrSlug(instanceIdOrSlug);
  if (!instance) {
    throw new Error(`Instance "${instanceIdOrSlug}" not found.`);
  }

  const dimensions = assertDim(instance.embeddingDim);
  const secrets = await getAllSecretsById(instance.id);
  const provider = instance.provider ?? "openai";

  let ctx: EmbeddingContext;
  if (provider === "bedrock") {
    // Per-instance secret wins; otherwise fall back to AWS_REGION on the engine.
    // CONVENTION-EXCEPTION: process.env.AWS_REGION read directly (mirrors ai-gateway/providers/bedrock.ts).
    const region = secrets[SECRET_KEYS.AWS_REGION] ?? process.env.AWS_REGION;
    if (!region) {
      throw new Error(
        `AWS region is required for Bedrock embeddings on instance "${instance.slug}". Set AWS_REGION on the engine, or configure aws_region in Settings → AI Provider.`,
      );
    }
    ctx = {
      instanceId: instance.id,
      dimensions,
      credentials: {
        provider: "bedrock",
        accessKeyId: secrets[SECRET_KEYS.AWS_ACCESS_KEY_ID],
        secretAccessKey: secrets[SECRET_KEYS.AWS_SECRET_ACCESS_KEY],
        region,
      },
    };
  } else {
    // openai + anthropic-fallback → OpenAI
    const apiKey = secrets[SECRET_KEYS.OPENAI_API_KEY];
    if (!apiKey) {
      throw new Error(
        `OpenAI API key required for embeddings on instance "${instance.slug}". Configure it in Settings → AI Provider.`,
      );
    }
    ctx = { instanceId: instance.id, dimensions, credentials: { provider: "openai", apiKey } };
  }

  cache.set(instanceIdOrSlug, ctx);
  return ctx;
}
