// SPDX-License-Identifier: AGPL-3.0-or-later

import { embed, embedMany } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { EmbeddingDim } from "../types.js";
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
  if (accessKeyId && secretAccessKey) {
    return createAmazonBedrock({ accessKeyId, secretAccessKey, region });
  }

  return createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain() });
}

function buildModel(opts: BedrockCallOptions) {
  const provider = buildProvider(opts);
  // AI SDK v6: the embedding factory takes only the model id; per-call settings
  // (e.g. `dimensions`) are passed via `providerOptions` on embed()/embedMany().
  return provider.embedding(EMBEDDING_MODEL_IDS.bedrock);
}

export async function embedBedrock(text: string, opts: BedrockCallOptions): Promise<number[]> {
  assertDimSupported("bedrock", opts.dimensions);
  const model = buildModel(opts);
  const { embedding } = await embed({
    model,
    value: text,
    providerOptions: { bedrock: { dimensions: opts.dimensions } },
  });
  return embedding;
}

export async function embedManyBedrock(texts: string[], opts: BedrockCallOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) {
    const single = await embedBedrock(texts[0], opts);
    return [single];
  }
  assertDimSupported("bedrock", opts.dimensions);
  const model = buildModel(opts);
  const { embeddings } = await embedMany({
    model,
    values: texts,
    providerOptions: { bedrock: { dimensions: opts.dimensions } },
  });
  return embeddings;
}
