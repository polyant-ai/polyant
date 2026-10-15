// SPDX-License-Identifier: AGPL-3.0-or-later

import type { STTProviderAdapter, STTProviderName } from "./types.js";
import { openAIWhisperAdapter } from "./providers/openai-whisper.js";
import { deepgramAdapter } from "./providers/deepgram.js";
import { awsTranscribeAdapter } from "./providers/aws-transcribe.js";

const BUILT_IN_ADAPTERS: readonly STTProviderAdapter[] = [openAIWhisperAdapter, deepgramAdapter, awsTranscribeAdapter];

const registry = new Map<STTProviderName, STTProviderAdapter>();

function register(adapter: STTProviderAdapter): void {
  registry.set(adapter.name, adapter);
}

BUILT_IN_ADAPTERS.forEach(register);

export function registerSTTProvider(adapter: STTProviderAdapter): void {
  register(adapter);
}

export function resolveSTTProvider(name: STTProviderName): STTProviderAdapter {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(`Unknown STT provider: ${name}`);
  }
  return adapter;
}

export function _resetSTTRegistry(): void {
  registry.clear();
  BUILT_IN_ADAPTERS.forEach(register);
}
