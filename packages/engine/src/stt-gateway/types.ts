// SPDX-License-Identifier: AGPL-3.0-or-later

export type STTProviderName = "openai" | "aws" | "deepgram";

/** Per-instance STT setting: a real provider, or the explicit opt-out. */
export type InstanceSttSetting = STTProviderName | "disabled";

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
