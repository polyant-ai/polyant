// SPDX-License-Identifier: AGPL-3.0-or-later

import { embed, embedMany } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { EmbeddingDim } from "../types.js";
import { EMBEDDING_MODEL_IDS, assertDimSupported } from "../config.js";

interface BedrockCallOptions {
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly region: string;
  readonly dimensions: EmbeddingDim;
}

function buildModel(opts: BedrockCallOptions) {
  // Explicit per-instance credentials take precedence. Otherwise delegate to the
  // AWS SDK default provider chain (ECS task role, EC2 IMDS, SSO, shared
  // credentials) — @ai-sdk/amazon-bedrock only reads env vars by default,
  // mirroring the chat provider's resolution in ai-gateway/providers/bedrock.ts.
  const provider =
    opts.accessKeyId && opts.secretAccessKey
      ? createAmazonBedrock({
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
          region: opts.region,
        })
      : createAmazonBedrock({
          region: opts.region,
          credentialProvider: fromNodeProviderChain(),
        });
  // Titan v2 settings type only allows 256 | 512 | 1024. assertDimSupported()
  // guarantees a supported value here, but the union still includes 1536 (OpenAI),
  // so narrow with a cast.
  return provider.embedding(EMBEDDING_MODEL_IDS.bedrock, {
    dimensions: opts.dimensions as 1024,
  });
}

export async function embedBedrock(text: string, opts: BedrockCallOptions): Promise<number[]> {
  assertDimSupported("bedrock", opts.dimensions);
  const model = buildModel(opts);
  const { embedding } = await embed({ model, value: text });
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
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}
