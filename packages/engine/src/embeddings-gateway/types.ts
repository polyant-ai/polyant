// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which embedder produced a vector, as stored on `instances.embedding_provider`
 * and on every `memories` / `knowledge_chunks` row.
 *
 * A string rather than a union of the two built-ins: an embedder can be
 * registered at boot (`registry.ts`), and a closed union here would have to name
 * every one of them. What narrows it is `isKnownEmbeddingProvider()` at the API
 * boundary, not the type.
 */
export type EmbeddingProvider = string;

export type EmbeddingDim = 1024 | 1536;

export interface OpenAICredentials {
  readonly provider: "openai";
  readonly apiKey: string;
}

export interface BedrockCredentials {
  readonly provider: "bedrock";
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly region: string;
}

/**
 * A registered OpenAI-compatible embedder. Carries its registration so the
 * shared caller needs no second lookup, and so the resolver stays the only place
 * that reads secrets.
 */
export interface CompatibleEmbeddingCredentials {
  readonly provider: "openai-compatible";
  /** The registered provider name (`instances.embedding_provider`). */
  readonly name: string;
  readonly apiKey: string;
}

export type EmbeddingCredentials =
  | OpenAICredentials
  | BedrockCredentials
  | CompatibleEmbeddingCredentials;

export interface EmbedOptions {
  readonly credentials: EmbeddingCredentials;
  readonly dimensions: EmbeddingDim;
  /**
   * The embedder's own name, as `instances.embedding_provider` holds it, and as
   * every `memories` / `knowledge_chunks` row records it.
   *
   * Separate from `credentials.provider`, which is the TRANSPORT discriminant
   * (`openai` | `bedrock` | `openai-compatible`) the dispatch switches on. The
   * two coincide for the built-ins and diverge for a registered embedder, and
   * the persistence sites used to record the discriminant: every registered
   * embedder's rows were stamped `openai-compatible`, which collapses distinct
   * embedders into one name and matches nothing the agent is configured with.
   * Nothing branches on that column today — it is the only record of which
   * embedder produced a vector, which is what a "which rows need re-embedding"
   * question is answered from.
   *
   * On `EmbedOptions` rather than on a context, so every context that feeds the
   * ingestion pipeline carries it under one name.
   */
  readonly providerName: EmbeddingProvider;
}

export interface EmbeddingContext extends EmbedOptions {
  readonly instanceId: string;
}
