// SPDX-License-Identifier: AGPL-3.0-or-later

import { embed, embedMany } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { EmbeddingDim, EmbeddingResult } from "../types.js";
import { EMBEDDING_MODEL_IDS, assertDimSupported } from "../config.js";

interface BedrockCallOptions {
  readonly apiKey?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly region: string;
  readonly dimensions: EmbeddingDim;
}

/**
 * The same precedence as the chat provider in ai-gateway/providers/bedrock.ts,
 * so one agent's chat and embeddings authenticate the same way: the per-agent
 * Bedrock API key (bearer token) first, then the explicit SigV4 key pair, then
 * the AWS SDK default provider chain (ECS task role, EC2 IMDS, SSO, shared
 * credentials) — @ai-sdk/amazon-bedrock only reads env vars by default.
 */
function buildProvider(opts: BedrockCallOptions) {
  const { region } = opts;
  const apiKey = opts.apiKey?.trim();
  if (apiKey) return createAmazonBedrock({ apiKey, region });

  const accessKeyId = opts.accessKeyId?.trim();
  const secretAccessKey = opts.secretAccessKey?.trim();
  // `apiKey: ""` keeps the SDK from filling the key from
  // AWS_BEARER_TOKEN_BEDROCK, which would outrank this key pair.
  if (accessKeyId && secretAccessKey) {
    return createAmazonBedrock({ apiKey: "", accessKeyId, secretAccessKey, region });
  }

  return createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain() });
}

function buildModel(opts: BedrockCallOptions) {
  const provider = buildProvider(opts);
  // AI SDK v6: the embedding factory takes only the model id; per-call settings
  // (e.g. `dimensions`) are passed via `providerOptions` on embed()/embedMany().
  return provider.embedding(EMBEDDING_MODEL_IDS.bedrock);
}

export async function embedBedrock(text: string, opts: BedrockCallOptions): Promise<EmbeddingResult> {
  assertDimSupported("bedrock", opts.dimensions);
  const model = buildModel(opts);
  const { embedding, usage } = await embed({
    model,
    value: text,
    providerOptions: { bedrock: { dimensions: opts.dimensions } },
  });
  return { embeddings: [embedding], tokens: usage?.tokens ?? 0 };
}

export async function embedManyBedrock(texts: string[], opts: BedrockCallOptions): Promise<EmbeddingResult> {
  if (texts.length === 0) return { embeddings: [], tokens: 0 };
  if (texts.length === 1) return embedBedrock(texts[0], opts);
  assertDimSupported("bedrock", opts.dimensions);
  const model = buildModel(opts);
  const { embeddings, usage } = await embedMany({
    model,
    values: texts,
    providerOptions: { bedrock: { dimensions: opts.dimensions } },
  });
  return { embeddings, tokens: usage?.tokens ?? 0 };
}
