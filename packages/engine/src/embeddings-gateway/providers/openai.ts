// SPDX-License-Identifier: AGPL-3.0-or-later

import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingDim, EmbeddingResult } from "../types.js";
import { EMBEDDING_MODEL_IDS, assertDimSupported } from "../config.js";

interface OpenAICallOptions {
  readonly apiKey: string;
  readonly dimensions: EmbeddingDim;
}

function buildModel(apiKey: string) {
  if (!apiKey) {
    throw new Error(
      "OpenAI API key required for embeddings. Configure it in admin panel under Settings → AI Provider.",
    );
  }
  const provider = createOpenAI({ apiKey });
  // AI SDK v6: the embedding factory takes only the model id; per-call settings
  // (e.g. `dimensions`) are passed via `providerOptions` on embed()/embedMany().
  return provider.embedding(EMBEDDING_MODEL_IDS.openai);
}

export async function embedOpenAI(text: string, opts: OpenAICallOptions): Promise<EmbeddingResult> {
  assertDimSupported("openai", opts.dimensions);
  const model = buildModel(opts.apiKey);
  const { embedding, usage } = await embed({
    model,
    value: text,
    providerOptions: { openai: { dimensions: opts.dimensions } },
  });
  return { embeddings: [embedding], tokens: usage?.tokens ?? 0 };
}

export async function embedManyOpenAI(texts: string[], opts: OpenAICallOptions): Promise<EmbeddingResult> {
  if (texts.length === 0) return { embeddings: [], tokens: 0 };
  if (texts.length === 1) return embedOpenAI(texts[0], opts);
  assertDimSupported("openai", opts.dimensions);
  const model = buildModel(opts.apiKey);
  const { embeddings, usage } = await embedMany({
    model,
    values: texts,
    providerOptions: { openai: { dimensions: opts.dimensions } },
  });
  return { embeddings, tokens: usage?.tokens ?? 0 };
}
