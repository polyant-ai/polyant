// SPDX-License-Identifier: AGPL-3.0-or-later

import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingDim } from "../types.js";
import { EMBEDDING_MODEL_IDS, assertDimSupported } from "../config.js";

interface OpenAICallOptions {
  readonly apiKey: string;
  readonly dimensions: EmbeddingDim;
}

function buildModel(apiKey: string, dimensions: EmbeddingDim) {
  if (!apiKey) {
    throw new Error(
      "OpenAI API key required for embeddings. Configure it in admin panel under Settings → AI Provider.",
    );
  }
  const provider = createOpenAI({ apiKey });
  return provider.embedding(EMBEDDING_MODEL_IDS.openai, { dimensions });
}

export async function embedOpenAI(text: string, opts: OpenAICallOptions): Promise<number[]> {
  assertDimSupported("openai", opts.dimensions);
  const model = buildModel(opts.apiKey, opts.dimensions);
  const { embedding } = await embed({ model, value: text });
  return embedding;
}

export async function embedManyOpenAI(texts: string[], opts: OpenAICallOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) {
    const single = await embedOpenAI(texts[0], opts);
    return [single];
  }
  assertDimSupported("openai", opts.dimensions);
  const model = buildModel(opts.apiKey, opts.dimensions);
  const { embeddings } = await embedMany({ model, values: texts });
  return embeddings;
}
