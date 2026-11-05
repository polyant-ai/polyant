// SPDX-License-Identifier: AGPL-3.0-or-later

export const STT_PROVIDER_NAMES = ["openai", "aws", "deepgram"] as const;
export type STTProviderName = (typeof STT_PROVIDER_NAMES)[number];

/** Per-instance STT setting: a real provider, or the explicit opt-out. */
export const INSTANCE_STT_SETTINGS = [...STT_PROVIDER_NAMES, "disabled"] as const;
export type InstanceSttSetting = (typeof INSTANCE_STT_SETTINGS)[number];

export interface STTOpenAICredentials {
  apiKey: string;
  model?: string;
}

export interface STTAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface STTDeepgramCredentials {
  apiKey: string;
  model?: string;
}

export interface STTCredentials {
  openai?: STTOpenAICredentials;
  aws?: STTAwsCredentials;
  deepgram?: STTDeepgramCredentials;
}

export interface STTRequest {
  audio: Buffer;
  mimeType: string;
  languageHint?: string;
  credentials: STTCredentials;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface STTResponse {
  text: string;
  language?: string;
  durationSec?: number;
  confidence?: number;
  provider: STTProviderName;
  model: string;
  latencyMs: number;
}

export interface STTProviderAdapter {
  readonly name: STTProviderName;
  transcribe(req: STTRequest): Promise<STTResponse>;
}
