// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { transcribe } from "../stt-gateway/index.js";
import {
  STTMissingCredentialsError,
  STTProviderError,
  STTTimeoutError,
  STTUnsupportedFormatError,
} from "../stt-gateway/errors.js";
import type { STTProviderName } from "../stt-gateway/types.js";
import { aiLogger } from "../ai-gateway/logger.js";
import { estimateSttCost } from "../ai-gateway/config.js";
import type { AudioReplyReason } from "./audio-replies.js";
import { audioReply } from "./audio-replies.js";
import { createLogger } from "../utils/create-logger.js";

const log = createLogger();

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

  const config = await resolveInstanceConfig(asInstanceSlug(input.instanceSlug));
  const provider = config.stt.provider;

  if (provider === "disabled") {
    return fail("stt_disabled");
  }

  if (!hasCredentialsFor(provider, config.stt.credentials)) {
    log.error("stt", `instance="${input.instanceSlug}" provider="${provider}" missing credentials`);
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

    // The provider processed (and billed) the audio whether or not it heard words:
    // every completed call is logged with its cost before branching on the text.
    const durationSec = response.durationSec ?? input.durationSec;
    const cleaned = response.text.trim();
    log.info(
      "stt",
      `instance="${input.instanceSlug}" provider="${provider}" mime="${input.mimeType}" durationSec=${durationSec ?? "?"} latencyMs=${response.latencyMs} ok=${cleaned.length > 0}`,
    );
    aiLogger.log(
      aiLogger.createEntry(
        provider,
        response.model,
        "fast",
        false,
        0,
        0,
        0,
        estimateSttCost(provider, response.model, durationSec ?? 0),
        response.latencyMs,
        0,
        0,
        input.conversationId,
        asInstanceSlug(input.instanceSlug),
        "service",
      ),
    );

    if (cleaned.length === 0) {
      log.warn("stt", `instance="${input.instanceSlug}" provider="${provider}" empty transcript`);
      return fail("empty_transcript");
    }

    return {
      ok: true,
      text: cleaned,
      metadata: {
        originalKind: "audio",
        durationSec,
        sttProvider: provider,
        language: response.language,
      },
      latencyMs: response.latencyMs,
    };
  } catch (err) {
    if (err instanceof STTUnsupportedFormatError) return fail("unsupported_format");
    if (err instanceof STTMissingCredentialsError) return fail("provider_error");
    if (err instanceof STTTimeoutError || err instanceof STTProviderError) {
      log.error("stt", `instance="${input.instanceSlug}" provider="${provider}" failed`, err);
      return fail(err instanceof STTTimeoutError ? "timeout" : "provider_error");
    }
    log.error("stt", `instance="${input.instanceSlug}" provider="${provider}" unknown error`, err);
    return fail("provider_error");
  }
}

export interface InboundAudioClip {
  audio: Buffer;
  mimeType: string;
  /** Best-effort duration reported by the channel. */
  durationSec?: number;
}

export type TranscribeInboundResult =
  /** `text` is the message text with every transcript appended; `metadata` (absent when there were no clips) is spread into the message metadata. */
  | { ok: true; text: string; metadata?: { originalKind: "audio"; audio: TranscribeAudioMetadata & { latencyMs: number } } }
  /** Send `reply` to the person and stop: a clip could not be transcribed. */
  | { ok: false; reply: string };

/**
 * The inbound-audio contract shared by the messaging channels: transcribe each
 * clip in order, stop at the first failure with the reply to send, and append
 * the transcripts to the message text, one per line. The adapter only
 * downloads the audio and sends the reply.
 */
export async function transcribeInbound(input: {
  instanceSlug: string;
  conversationId: string;
  clips: InboundAudioClip[];
  text: string;
}): Promise<TranscribeInboundResult> {
  let text = input.text;
  let metadata: Extract<TranscribeInboundResult, { ok: true }>["metadata"] | undefined;
  for (const clip of input.clips) {
    const result = await transcribeAudio({
      audio: clip.audio,
      mimeType: clip.mimeType,
      durationSec: clip.durationSec,
      instanceSlug: input.instanceSlug,
      conversationId: input.conversationId,
    });
    if (!result.ok) return { ok: false, reply: result.userReply };
    text = text ? `${text}\n${result.text}` : result.text;
    metadata = { originalKind: "audio", audio: { ...result.metadata, latencyMs: result.latencyMs } };
  }
  return { ok: true, text, metadata };
}
