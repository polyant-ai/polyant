import type { EmbedOptions } from "./types.js";
import { embedOpenAI, embedManyOpenAI } from "./providers/openai.js";
import { embedBedrock, embedManyBedrock } from "./providers/bedrock.js";

export async function embed(text: string, opts: EmbedOptions): Promise<number[]> {
  const { credentials, dimensions } = opts;
  if (credentials.provider === "openai") {
    return embedOpenAI(text, { apiKey: credentials.apiKey, dimensions });
  }
  return embedBedrock(text, {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    dimensions,
  });
}

export async function embedMany(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const { credentials, dimensions } = opts;
  if (credentials.provider === "openai") {
    return embedManyOpenAI(texts, { apiKey: credentials.apiKey, dimensions });
  }
  return embedManyBedrock(texts, {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    dimensions,
  });
}

export type {
  EmbeddingProvider,
  EmbeddingCredentials,
  EmbedOptions,
  EmbeddingContext,
  EmbeddingDim,
  OpenAICredentials,
  BedrockCredentials,
} from "./types.js";

export { resolveEmbeddingContext } from "./provider-resolver.js";
