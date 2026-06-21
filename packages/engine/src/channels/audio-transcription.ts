// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { asAgentSlug } from "../instances/identifiers.js";
import { transcribe } from "../stt-gateway/index.js";
import {
  STTMissingCredentialsError,
  STTProviderError,
  STTUnsupportedFormatError,
} from "../stt-gateway/errors.js";
import type { STTProviderName } from "../stt-gateway/types.js";
import { aiLogger } from "../ai-gateway/logger.js";
import { estimateSttCost } from "../ai-gateway/config.js";
import type { AudioReplyReason } from "./audio-replies.js";
import { audioReply } from "./audio-replies.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DURATION_SEC = 60;
const TIMEOUT_MS = 30_000;

export interface TranscribeAudioInput {
  audio: Buffer;
  mimeType: string;
  /** Best-effort duration reported by the channel (Telegram provides it). */
  durationSec?: number;
  instanceSlug: string;
  languageHint?: string;
  /** When provided, the STT cost is logged on `ai_logs` as a `service` call linked to this conversation. */
  conversationId?: string;
}

export interface TranscribeAudioMetadata {
  originalKind: "audio";
  durationSec?: number;
  sttProvider: STTProviderName;
  language?: string;
}

export type TranscribeAudioResult =
  | { ok: true; text: string; metadata: TranscribeAudioMetadata; latencyMs: number }
  | { ok: false; reason: AudioReplyReason; userReply: string };

function fail(reason: AudioReplyReason): TranscribeAudioResult {
  return { ok: false, reason, userReply: audioReply(reason) };
}

function hasCredentialsFor(provider: STTProviderName, creds: {
  openai?: unknown;
  aws?: unknown;
  deepgram?: unknown;
}): boolean {
  if (provider === "openai") return creds.openai != null;
  if (provider === "aws") return creds.aws != null;
  if (provider === "deepgram") return creds.deepgram != null;
  return false;
}

export async function transcribeAudio(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
  if (input.audio.length > MAX_BYTES) return fail("too_large");
  if (typeof input.durationSec === "number" && input.durationSec > MAX_DURATION_SEC) {
    return fail("too_long");
  }

  const config = await resolveInstanceConfig(asAgentSlug(input.instanceSlug));
  const provider = config.stt.provider;

  if (!hasCredentialsFor(provider, config.stt.credentials)) {
    console.error(
      `[stt] instance="${input.instanceSlug}" provider="${provider}" missing credentials`,
    );
    return fail("provider_error");
  }

  try {
    const response = await transcribe(provider, {
      audio: input.audio,
      mimeType: input.mimeType,
      languageHint: input.languageHint,
      credentials: config.stt.credentials,
      timeoutMs: TIMEOUT_MS,
    });

    const cleaned = response.text.trim();
    if (cleaned.length === 0) {
      console.warn(
        `[stt] instance="${input.instanceSlug}" provider="${provider}" empty transcript`,
      );
      return fail("empty_transcript");
    }

    console.log(
      `[stt] instance="${input.instanceSlug}" provider="${provider}" mime="${input.mimeType}" durationSec=${response.durationSec ?? input.durationSec ?? "?"} latencyMs=${response.latencyMs} ok=true`,
    );

    const billedDurationSec = response.durationSec ?? input.durationSec ?? 0;
    aiLogger.log(
      aiLogger.createEntry(
        provider,
        response.model,
        "fast",
        false,
        0,
        0,
        0,
        estimateSttCost(provider, response.model, billedDurationSec),
        response.latencyMs,
        0,
        0,
        input.conversationId,
        asAgentSlug(input.instanceSlug),
        "service",
      ),
    );

    return {
      ok: true,
      text: cleaned,
      metadata: {
        originalKind: "audio",
        durationSec: response.durationSec ?? input.durationSec,
        sttProvider: provider,
        language: response.language,
      },
      latencyMs: response.latencyMs,
    };
  } catch (err) {
    if (err instanceof STTUnsupportedFormatError) return fail("unsupported_format");
    if (err instanceof STTMissingCredentialsError) return fail("provider_error");
    if (err instanceof STTProviderError) {
      console.error(
        `[stt] instance="${input.instanceSlug}" provider="${provider}" failed: ${err.message}`,
      );
      return fail(err.message.includes("aborted") ? "timeout" : "provider_error");
    }
    console.error(
      '[stt] instance="%s" provider="%s" unknown error:',
      input.instanceSlug,
      provider,
      err,
    );
    return fail("provider_error");
  }
}
