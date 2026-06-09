// SPDX-License-Identifier: AGPL-3.0-or-later

import { findInstanceBySlug } from "./store.js";
import { asInstanceSlug, type InstanceSlug } from "./identifiers.js";
import { getAllSecretsById } from "./secrets.store.js";
import { SECRET_KEYS } from "./secrets.store.js";
import { TtlCache } from "../utils/ttl-cache.js";
import { isThinkingCapable, resolveModel } from "../ai-gateway/config.js";
import type { ModelTier } from "../ai-gateway/types.js";
import type { STTCredentials, STTProviderName } from "../stt-gateway/types.js";

export interface InstanceConfig {
  provider: string | undefined;
  model: string | undefined;
  apiKeys: {
    openai?: string;
    anthropic?: string;
    bedrock_access_key_id?: string;
    bedrock_secret_access_key?: string;
    bedrock_region?: string;
  };
  /** All decrypted secrets (for tools and other subsystems). */
  secrets: Record<string, string>;
  langsmith: { enabled: boolean; project: string | null; apiKey?: string };
  authEnabled: boolean;
  authApiKey?: string;
  memoryEnabled: boolean;
  knowledgeEnabled: boolean;
  /**
   * Effective extended-thinking flag: true only when the user has enabled the
   * preference AND the currently selected model actually supports thinking.
   * The DB-persisted value is intentionally NOT auto-cleared on model change
   * (so the preference reapplies if the user switches back to a capable
   * model); the gate lives here to keep runtime requests coherent.
   */
  thinkingEnabled: boolean;
  /** When true, the conversation state store is rendered read-only into the system prompt. */
  stateInPromptEnabled: boolean;
  /** When true, prior-turn tool calls + results are reconstructed (truncated) into the model's history. */
  toolResultsInHistoryEnabled: boolean;
  /** When true, the exact LLM request payload (system + messages + tools) is persisted per turn for debug. */
  debugEnabled: boolean;
  stt: {
    provider: STTProviderName;
    credentials: STTCredentials;
  };
}

/**
 * Resolve which model the gateway will actually call given an instance's
 * provider/model selection. When `model` is unset, the gateway falls back to
 * the `standard` tier — match that fallback here so the capability gate
 * matches what runs at request time.
 */
function effectiveModelFor(provider: string | undefined, model: string | undefined): string | undefined {
  if (model) return model;
  if (!provider) return undefined;
  try {
    return resolveModel(provider, "standard" satisfies ModelTier);
  } catch {
    return undefined;
  }
}

/** In-memory cache with TTL (30 s, max 200 instances). */
const cache = new TtlCache<string, InstanceConfig>({ maxSize: 200, ttlMs: 30_000 });

/** Invalidate cached config for a specific instance. */
export function invalidateInstanceConfigCache(slug: InstanceSlug): void {
  cache.delete(slug);
}

/** Invalidate all cached configs. */
export function invalidateAllInstanceConfigCache(): void {
  cache.clear();
}

/**
 * Resolve full instance configuration including decrypted secrets.
 * Results are cached for 30 seconds.
 */
export async function resolveInstanceConfig(instanceSlug: InstanceSlug): Promise<InstanceConfig> {
  const cached = cache.get(instanceSlug);
  if (cached) {
    return cached;
  }

  const instance = await findInstanceBySlug(asInstanceSlug(instanceSlug));
  if (!instance) {
    // Return a minimal config for unknown instances
    return {
      provider: undefined,
      model: undefined,
      apiKeys: {},
      secrets: {},
      langsmith: { enabled: false, project: null },
      authEnabled: false,
      memoryEnabled: false,
      knowledgeEnabled: false,
      thinkingEnabled: false,
      stateInPromptEnabled: false,
      toolResultsInHistoryEnabled: false,
      debugEnabled: false,
      stt: { provider: "openai", credentials: {} },
    };
  }

  const secrets = await getAllSecretsById(instance.id);

  const sttProviderRaw = (instance as { sttProvider?: string | null }).sttProvider ?? "openai";
  const sttProvider: STTProviderName =
    sttProviderRaw === "aws" || sttProviderRaw === "deepgram" ? sttProviderRaw : "openai";

  const sttCredentials: STTCredentials = {};
  if (sttProvider === "openai" && secrets[SECRET_KEYS.OPENAI_API_KEY]) {
    sttCredentials.openai = { apiKey: secrets[SECRET_KEYS.OPENAI_API_KEY] };
  }
  if (
    sttProvider === "aws" &&
    secrets[SECRET_KEYS.AWS_ACCESS_KEY_ID] &&
    secrets[SECRET_KEYS.AWS_SECRET_ACCESS_KEY] &&
    secrets[SECRET_KEYS.AWS_REGION]
  ) {
    sttCredentials.aws = {
      accessKeyId: secrets[SECRET_KEYS.AWS_ACCESS_KEY_ID],
      secretAccessKey: secrets[SECRET_KEYS.AWS_SECRET_ACCESS_KEY],
      region: secrets[SECRET_KEYS.AWS_REGION],
    };
  }
  if (sttProvider === "deepgram" && secrets[SECRET_KEYS.DEEPGRAM_API_KEY]) {
    sttCredentials.deepgram = { apiKey: secrets[SECRET_KEYS.DEEPGRAM_API_KEY] };
  }

  const config: InstanceConfig = {
    provider: instance.provider ?? undefined,
    model: instance.model ?? undefined,
    apiKeys: {
      openai: secrets[SECRET_KEYS.OPENAI_API_KEY],
      anthropic: secrets[SECRET_KEYS.ANTHROPIC_API_KEY],
      bedrock_access_key_id: secrets[SECRET_KEYS.AWS_ACCESS_KEY_ID],
      bedrock_secret_access_key: secrets[SECRET_KEYS.AWS_SECRET_ACCESS_KEY],
      bedrock_region: secrets[SECRET_KEYS.AWS_REGION],
    },
    secrets,
    langsmith: {
      enabled: instance.langsmithEnabled,
      project: instance.langsmithProject,
      apiKey: secrets[SECRET_KEYS.LANGSMITH_API_KEY],
    },
    authEnabled: instance.authEnabled,
    authApiKey: secrets[SECRET_KEYS.AUTH_API_KEY],
    memoryEnabled: instance.memoryEnabled,
    knowledgeEnabled: instance.knowledgeEnabled,
    // Gate the persisted preference behind the actual capability of the model
    // that will run. A stale `thinkingEnabled=true` after switching to a
    // non-capable model has no runtime effect.
    thinkingEnabled:
      instance.thinkingEnabled &&
      isThinkingCapable(
        instance.provider ?? "",
        effectiveModelFor(instance.provider ?? undefined, instance.model ?? undefined) ?? "",
      ),
    stateInPromptEnabled: instance.stateInPromptEnabled,
    toolResultsInHistoryEnabled: instance.toolResultsInHistoryEnabled,
    debugEnabled: instance.debugEnabled,
    stt: { provider: sttProvider, credentials: sttCredentials },
  };

  cache.set(instanceSlug, config);
  return config;
}
