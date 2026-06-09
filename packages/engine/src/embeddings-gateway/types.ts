// SPDX-License-Identifier: AGPL-3.0-or-later

export type EmbeddingProvider = "openai" | "bedrock";

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

export type EmbeddingCredentials = OpenAICredentials | BedrockCredentials;

export interface EmbedOptions {
  readonly credentials: EmbeddingCredentials;
  readonly dimensions: EmbeddingDim;
}

export interface EmbeddingContext extends EmbedOptions {
  readonly instanceId: string;
}
