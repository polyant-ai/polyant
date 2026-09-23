// SPDX-License-Identifier: AGPL-3.0-or-later

import { embed, embedMany } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingDim } from "../types.js";
import { assertDimSupported } from "../config.js";
import type { EmbeddingProviderRegistration } from "../registry.js";

/**
 * The embedder for any OpenAI-compatible `/v1/embeddings` endpoint, driven by a
 * registration rather than by a per-provider file. One caller for all of them
 * because nothing differs but the base URL, the model id and the key.
 *
 * `dimensions` rides in `providerOptions` under the provider's own namespace, the
 * way the OpenAI embedder passes it. An endpoint that ignores the param returns
 * its native size instead, which is why a registration declares the sizes it will
 * really produce and `assertDimSupported` refuses the rest BEFORE the call — a
 * vector of the wrong length is not an error at the provider, it is a row that
 * lands in the wrong column or none at all.
 */
interface CompatibleCallOptions {
  readonly registration: EmbeddingProviderRegistration;
  readonly apiKey: string;
  readonly dimensions: EmbeddingDim;
}

function buildModel(opts: CompatibleCallOptions) {
  const { registration, apiKey } = opts;
  if (!apiKey) {
    throw new Error(
      `${registration.label} API key required for embeddings. Configure it in the admin panel under Settings → AI Provider.`,
    );
  }
  const factory = createOpenAICompatible({
    name: registration.name,
    baseURL: registration.baseURL,
    apiKey,
  });
  return factory.textEmbeddingModel(registration.modelId);
}

export async function embedCompatible(text: string, opts: CompatibleCallOptions): Promise<number[]> {
  assertDimSupported(opts.registration.name, opts.dimensions);
  const { embedding } = await embed({
    model: buildModel(opts),
    value: text,
    providerOptions: { [opts.registration.name]: { dimensions: opts.dimensions } },
  });
  return assertVectorLength([embedding], opts)[0];
}

export async function embedManyCompatible(texts: string[], opts: CompatibleCallOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embedCompatible(texts[0], opts)];
  assertDimSupported(opts.registration.name, opts.dimensions);
  const { embeddings } = await embedMany({
    model: buildModel(opts),
    values: texts,
    providerOptions: { [opts.registration.name]: { dimensions: opts.dimensions } },
  });
  return assertVectorLength(embeddings, opts);
}

/**
 * Refuse a vector that is not the length we asked for — once, for both entry
 * points.
 *
 * `assertDimSupported` above checks what the REGISTRATION claims; this checks
 * what the endpoint actually did. The two are different questions, and the gap
 * between them is where the documented-but-unverified `dimensions` support sits:
 * these endpoints serve a Matryoshka model at 1024 on request, and one that
 * ignored the request would return its native 4096 with the AI SDK handing it
 * over without complaint.
 *
 * Not silent corruption either way — the vector columns are typed `vector(1024)`
 * / `vector(1536)`, so Postgres rejects the insert. But it rejects it one layer
 * down and one document at a time, as a driver error on an ingestion that lands
 * in `status: error`, or as a logged failure inside fire-and-forget memory
 * extraction. This says which provider did it and what it returned, at the call.
 */
function assertVectorLength(vectors: number[][], opts: CompatibleCallOptions): number[][] {
  const wrong = vectors.find((vector) => vector.length !== opts.dimensions);
  if (wrong) {
    throw new Error(
      `${opts.registration.label} returned a ${wrong.length}-dimension embedding for model ` +
        `"${opts.registration.modelId}" where ${opts.dimensions} was requested — the endpoint ` +
        `appears to ignore the \`dimensions\` parameter, so it cannot serve this embedding space.`,
    );
  }
  return vectors;
}
