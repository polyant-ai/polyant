// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmbeddingContext, EmbeddingDim, EmbeddingProvider } from "./types.js";
import { findInstanceByIdOrSlug } from "../instances/resolve-instance-id.js";
import { getAllSecretsById, SECRET_KEYS } from "../instances/secrets.store.js";
import { TtlCache } from "../utils/ttl-cache.js";
import { getEmbeddingProvider } from "./registry.js";

function assertDim(dim: number): EmbeddingDim {
  if (dim !== 1024 && dim !== 1536) {
    throw new Error(`Unsupported instance.embedding_dim ${dim} (expected 1024 or 1536).`);
  }
  return dim;
}

// Hot-path cache keyed by the raw lookup value (id or slug); 30 s TTL matches
// config-resolver. Manual invalidation is wired into secret/instance mutations.
const cache = new TtlCache<string, EmbeddingContext>({ maxSize: 200, ttlMs: 30_000 });

/**
 * The `instance_secrets` keys an embedder cannot run without — the single answer
 * to that question, read by BOTH the resolver that builds the credentials and the
 * readiness check the panel renders.
 *
 * It is one function because it was two, and they disagreed: the resolver read a
 * registered embedder's own key while the readiness path fell through to
 * `openai_api_key`, so an agent embedding perfectly well on a registered provider
 * was reported as missing credentials — a red banner over a working pipeline, on
 * the surface whose only job is to be trusted about that.
 *
 * Bedrock is the asymmetric one on purpose: only the REGION is required, because
 * the access-key pair is optional (the host's AWS profile or IAM role stands in),
 * which mirrors `resolveEmbeddingContext`.
 */
export function requiredSecretKeysFor(provider: EmbeddingProvider): readonly string[] {
  const registration = getEmbeddingProvider(provider);
  if (registration) return [registration.apiKeySecret];
  if (provider === "bedrock") return [SECRET_KEYS.AWS_PROVIDER_REGION];
  return [SECRET_KEYS.OPENAI_API_KEY];
}

/**
 * It lives in the resolver, beside the code that reads the secrets, rather than
 * in `embeddings-gateway/config.ts`: that module stays a leaf with no dependency
 * on the secret store, so anything may import the embedder defaults without
 * pulling the database layer in behind them.
 */
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
  // The embedding provider is independent of the chat `provider`. Credentials are
  // resolved for the embedder regardless of which LLM the instance chats with.
  const provider = instance.embeddingProvider;

  let ctx: EmbeddingContext;
  const registration = getEmbeddingProvider(provider);
  if (registration) {
    // A registered OpenAI-compatible embedder, authenticated from the same
    // secrets as the built-ins, under the key its registration names.
    const apiKey = secrets[registration.apiKeySecret];
    if (!apiKey) {
      throw new Error(
        `${registration.label} API key required for embeddings on instance "${instance.slug}". Configure it in Settings → AI Provider.`,
      );
    }
    ctx = {
      instanceId: instance.id,
      dimensions,
      providerName: registration.name,
      credentials: { provider: "openai-compatible", name: registration.name, apiKey },
    };
  } else if (provider === "bedrock") {
    // Per-agent only: there is no deployment-wide region to fall back to.
    const region = secrets[SECRET_KEYS.AWS_PROVIDER_REGION];
    if (!region) {
      throw new Error(
        `AWS region is required for Bedrock embeddings on instance "${instance.slug}". Configure the AWS provider region in Settings → AI Provider.`,
      );
    }
    ctx = {
      instanceId: instance.id,
      dimensions,
      providerName: "bedrock",
      credentials: {
        provider: "bedrock",
        accessKeyId: secrets[SECRET_KEYS.AWS_PROVIDER_ACCESS_KEY_ID],
        secretAccessKey: secrets[SECRET_KEYS.AWS_PROVIDER_SECRET_ACCESS_KEY],
        region,
      },
    };
  } else if (provider === "openai") {
    const apiKey = secrets[SECRET_KEYS.OPENAI_API_KEY];
    if (!apiKey) {
      throw new Error(
        `OpenAI API key required for embeddings on instance "${instance.slug}". Configure it in Settings → AI Provider.`,
      );
    }
    ctx = {
      instanceId: instance.id,
      dimensions,
      providerName: "openai",
      credentials: { provider: "openai", apiKey },
    };
  } else {
    // The branch above used to be a bare `else`, which made OpenAI the answer for
    // ANY unrecognised name — so an agent configured for an embedder this
    // deployment does not serve had its data sent to OpenAI instead of failing,
    // and nothing said so. It
    // fails closed now: the import path validates the name, and a row that
    // predates that validation is a misconfiguration worth naming, not worth
    // silently rerouting.
    throw new Error(
      `Embedding provider "${provider}" on instance "${instance.slug}" is not available in this deployment.`,
    );
  }

  cache.set(instanceIdOrSlug, ctx);
  return ctx;
}
