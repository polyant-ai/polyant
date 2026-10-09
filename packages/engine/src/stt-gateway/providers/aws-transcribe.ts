// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type AudioStream,
  type LanguageCode,
} from "@aws-sdk/client-transcribe-streaming";

import type { STTProviderAdapter, STTRequest, STTResponse } from "../types.js";
import {
  STTMissingCredentialsError,
  STTProviderError,
  STTUnsupportedFormatError,
} from "../errors.js";

const CHUNK_SIZE = 16 * 1024;
const SAMPLE_RATE_HZ = 16_000;

/** Map an inbound MIME type to AWS Transcribe MediaEncoding (or null when unsupported). */
function mediaEncodingFor(mimeType: string): "ogg-opus" | "pcm" | "flac" | null {
  const m = mimeType.toLowerCase();
  if (m === "audio/ogg" || m.startsWith("audio/ogg;") || m === "audio/opus") return "ogg-opus";
  if (m === "audio/flac" || m === "audio/x-flac") return "flac";
  if (m === "audio/wav" || m === "audio/x-wav" || m === "audio/pcm") return "pcm";
  return null;
}

/** Map a 2-letter language hint into the BCP-47 codes Transcribe accepts. Limited set; defaults are safe. */
function languageCodeFor(hint?: string): LanguageCode | undefined {
  if (!hint) return undefined;
  const h = hint.toLowerCase();
  const map: Record<string, LanguageCode> = {
    it: "it-IT",
    en: "en-US",
    fr: "fr-FR",
    es: "es-ES",
    de: "de-DE",
    pt: "pt-PT",
  };
  return map[h] ?? undefined;
}

const OPUS_GRANULE_RATE_HZ = 48_000;

/**
 * Duration of an Ogg/Opus stream from its container: the granule position of the
 * last page counts 48 kHz samples, minus the pre-skip declared in OpusHead.
 */
function oggOpusDurationSec(buf: Buffer): number | undefined {
  const last = buf.lastIndexOf("OggS");
  if (last < 0 || last + 14 > buf.length || buf[last + 4] !== 0) return undefined;
  const granule = Number(buf.readBigInt64LE(last + 6));
  if (granule <= 0) return undefined;
  const head = buf.indexOf("OpusHead");
  const preSkip = head >= 0 && head + 12 <= buf.length ? buf.readUInt16LE(head + 10) : 0;
  return Math.max(0, granule - preSkip) / OPUS_GRANULE_RATE_HZ;
}

/** Duration of a FLAC stream from STREAMINFO (sample rate and total samples). */
function flacDurationSec(buf: Buffer): number | undefined {
  // "fLaC" + 4-byte block header, then STREAMINFO; rate/channels/bps/total at offset 18.
  if (buf.length < 26 || buf.toString("latin1", 0, 4) !== "fLaC") return undefined;
  const sampleRate = (buf[18] << 12) | (buf[19] << 4) | (buf[20] >> 4);
  const totalSamples = (buf[21] & 0x0f) * 2 ** 32 + buf.readUInt32BE(22);
  if (sampleRate === 0 || totalSamples === 0) return undefined;
  return totalSamples / sampleRate;
}

/** Duration of the 16-bit mono PCM this adapter declares to Transcribe (WAV header excluded). */
function pcmDurationSec(buf: Buffer): number {
  const isWav = buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE";
  const dataBytes = Math.max(0, buf.length - (isWav ? 44 : 0));
  return dataBytes / (2 * SAMPLE_RATE_HZ);
}

/**
 * The audio duration sent to Transcribe, which is what it bills. Read from the
 * container we stream; undefined when the container does not declare it.
 */
export function measureAudioDurationSec(
  buf: Buffer,
  encoding: "ogg-opus" | "pcm" | "flac",
): number | undefined {
  if (encoding === "ogg-opus") return oggOpusDurationSec(buf);
  if (encoding === "flac") return flacDurationSec(buf);
  return pcmDurationSec(buf);
}

async function* chunkAudio(buffer: Buffer): AsyncIterable<AudioStream> {
  for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
    yield { AudioEvent: { AudioChunk: buffer.subarray(i, i + CHUNK_SIZE) } };
  }
}

async function transcribe(req: STTRequest): Promise<STTResponse> {
  const cred = req.credentials.aws;
  if (!cred?.accessKeyId || !cred.secretAccessKey || !cred.region) {
    throw new STTMissingCredentialsError("aws");
  }

  const encoding = mediaEncodingFor(req.mimeType);
  if (!encoding) throw new STTUnsupportedFormatError("aws", req.mimeType);

  const client = new TranscribeStreamingClient({
    region: cred.region,
    credentials: {
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
    },
  });

  const languageCode = languageCodeFor(req.languageHint);

  const command = new StartStreamTranscriptionCommand({
    MediaEncoding: encoding,
    MediaSampleRateHertz: SAMPLE_RATE_HZ,
    LanguageCode: languageCode,
    IdentifyLanguage: languageCode ? undefined : true,
    AudioStream: chunkAudio(req.audio),
  });

  const start = Date.now();
  let response;
  try {
    response = await client.send(command);
  } catch (err) {
    throw new STTProviderError("aws", `send failed: ${(err as Error).message}`, { cause: err });
  }

  let finalText = "";
  let detectedLanguage: string | undefined;
  let lastEndTimeSec = 0;

  try {
    for await (const event of response.TranscriptResultStream ?? []) {
      const results = event.TranscriptEvent?.Transcript?.Results ?? [];
      for (const r of results) {
        if (typeof r.EndTime === "number") lastEndTimeSec = Math.max(lastEndTimeSec, r.EndTime);
        if (r.IsPartial) continue;
        const alt = r.Alternatives?.[0]?.Transcript;
        if (alt) finalText += (finalText ? " " : "") + alt;
        if (r.LanguageCode) detectedLanguage = r.LanguageCode;
      }
    }
  } catch (err) {
    throw new STTProviderError("aws", `stream error: ${(err as Error).message}`, { cause: err });
  }

  return {
    text: finalText.trim(),
    language: detectedLanguage,
    // Transcribe returns no billed duration. The container is authoritative for the
    // audio we streamed; result end times only cover speech, so they are a floor.
    durationSec: measureAudioDurationSec(req.audio, encoding) ?? (lastEndTimeSec || undefined),
    provider: "aws",
    model: "transcribe-streaming",
    latencyMs: Date.now() - start,
  };
}

export const awsTranscribeAdapter: STTProviderAdapter = {
  name: "aws",
  transcribe,
};
