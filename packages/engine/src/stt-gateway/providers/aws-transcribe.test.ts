// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { STTMissingCredentialsError, STTUnsupportedFormatError } from "../errors.js";

const { sendMock, TranscribeClientMock, StartStreamTranscriptionCommandMock } = vi.hoisted(() => {
  const sendMock = vi.fn();
  const TranscribeClientMock = vi.fn().mockImplementation(function () {
    return { send: sendMock };
  });
  const StartStreamTranscriptionCommandMock = vi.fn();
  return { sendMock, TranscribeClientMock, StartStreamTranscriptionCommandMock };
});

vi.mock("@aws-sdk/client-transcribe-streaming", () => ({
  TranscribeStreamingClient: TranscribeClientMock,
  StartStreamTranscriptionCommand: StartStreamTranscriptionCommandMock,
}));

import { awsTranscribeAdapter, measureAudioDurationSec } from "./aws-transcribe.js";

describe("awsTranscribeAdapter", () => {
  beforeEach(() => {
    sendMock.mockReset();
    TranscribeClientMock.mockClear();
    StartStreamTranscriptionCommandMock.mockClear();
  });

  it("throws STTMissingCredentialsError when credentials.aws is undefined", async () => {
    await expect(
      awsTranscribeAdapter.transcribe({
        audio: Buffer.from([0]),
        mimeType: "audio/ogg",
        credentials: {},
      }),
    ).rejects.toBeInstanceOf(STTMissingCredentialsError);
  });

  it("throws STTUnsupportedFormatError for non-Opus/PCM/Flac MIME", async () => {
    await expect(
      awsTranscribeAdapter.transcribe({
        audio: Buffer.from([0]),
        mimeType: "audio/mpeg",
        credentials: {
          aws: { accessKeyId: "AKIA", secretAccessKey: "x", region: "eu-west-1" },
        },
      }),
    ).rejects.toBeInstanceOf(STTUnsupportedFormatError);
  });

  it("aggregates non-partial Transcript events into a single text", async () => {
    sendMock.mockResolvedValueOnce({
      TranscriptResultStream: (async function* () {
        yield {
          TranscriptEvent: {
            Transcript: {
              Results: [
                {
                  IsPartial: true,
                  Alternatives: [{ Transcript: "ciao" }],
                },
              ],
            },
          },
        };
        yield {
          TranscriptEvent: {
            Transcript: {
              Results: [
                {
                  IsPartial: false,
                  Alternatives: [{ Transcript: "ciao mondo" }],
                  LanguageCode: "it-IT",
                },
              ],
            },
          },
        };
      })(),
    });

    const result = await awsTranscribeAdapter.transcribe({
      audio: Buffer.from([0x4f, 0x67, 0x67, 0x53]),
      mimeType: "audio/ogg",
      languageHint: "it",
      credentials: {
        aws: { accessKeyId: "AKIA", secretAccessKey: "x", region: "eu-west-1" },
      },
    });

    expect(result.text).toBe("ciao mondo");
    expect(result.language).toBe("it-IT");
    expect(result.provider).toBe("aws");
    expect(result.model).toBe("transcribe-streaming");

    // The SDK was constructed with our region + credentials
    expect(TranscribeClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "eu-west-1",
        credentials: { accessKeyId: "AKIA", secretAccessKey: "x" },
      }),
    );
    // The command got OGG-OPUS encoding
    expect(StartStreamTranscriptionCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaEncoding: "ogg-opus",
        MediaSampleRateHertz: 16000,
        LanguageCode: "it-IT",
      }),
    );
  });

  it("reports the result end time when the container declares no duration", async () => {
    sendMock.mockResolvedValueOnce({
      TranscriptResultStream: (async function* () {
        yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: false, EndTime: 7.5, Alternatives: [] }] } } };
      })(),
    });

    const result = await awsTranscribeAdapter.transcribe({
      audio: Buffer.from([0x00, 0x01]),
      mimeType: "audio/ogg",
      credentials: { aws: { accessKeyId: "AKIA", secretAccessKey: "x", region: "eu-west-1" } },
    });

    expect(result.text).toBe("");
    expect(result.durationSec).toBe(7.5);
  });
});

describe("measureAudioDurationSec", () => {
  function oggPage(granule: bigint, payload: Buffer): Buffer {
    const header = Buffer.alloc(27);
    header.write("OggS", 0, "latin1");
    header.writeBigInt64LE(granule, 6);
    return Buffer.concat([header, payload]);
  }

  it("reads an Ogg/Opus duration from the last granule position minus pre-skip", () => {
    const opusHead = Buffer.alloc(19);
    opusHead.write("OpusHead", 0, "latin1");
    opusHead.writeUInt16LE(312, 10);
    const audio = Buffer.concat([oggPage(0n, opusHead), oggPage(48_000n * 3n + 312n, Buffer.alloc(10))]);

    expect(measureAudioDurationSec(audio, "ogg-opus")).toBe(3);
  });

  it("reads a FLAC duration from STREAMINFO", () => {
    const buf = Buffer.alloc(42);
    buf.write("fLaC", 0, "latin1");
    // 16 kHz in 20 bits at byte 18, total samples (36 bits) ending at byte 25.
    const rate = 16_000;
    buf[18] = (rate >> 12) & 0xff;
    buf[19] = (rate >> 4) & 0xff;
    buf[20] = (rate & 0x0f) << 4;
    buf.writeUInt32BE(rate * 5, 22);

    expect(measureAudioDurationSec(buf, "flac")).toBe(5);
  });

  it("derives a PCM duration from byte length at 16 kHz 16-bit mono", () => {
    expect(measureAudioDurationSec(Buffer.alloc(64_000), "pcm")).toBe(2);
  });

  it("returns undefined for an Ogg buffer without pages", () => {
    expect(measureAudioDurationSec(Buffer.from([1, 2, 3]), "ogg-opus")).toBeUndefined();
  });
});
