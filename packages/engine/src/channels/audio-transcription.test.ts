// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveInstanceConfigMock, transcribeMock } = vi.hoisted(() => {
  return {
    resolveInstanceConfigMock: vi.fn(),
    transcribeMock: vi.fn(),
  };
});

vi.mock("../instances/config-resolver.js", () => ({
  resolveInstanceConfig: resolveInstanceConfigMock,
}));

vi.mock("../stt-gateway/index.js", () => ({
  transcribe: transcribeMock,
}));

import { transcribeAudio } from "./audio-transcription.js";

const FAKE_OPENAI_CONFIG = {
  stt: {
    provider: "openai" as const,
    credentials: { openai: { apiKey: "sk-test" } },
  },
};

describe("transcribeAudio", () => {
  beforeEach(() => {
    resolveInstanceConfigMock.mockReset();
    transcribeMock.mockReset();
    resolveInstanceConfigMock.mockResolvedValue(FAKE_OPENAI_CONFIG);
  });

  it("rejects audio larger than 10 MB", async () => {
    const result = await transcribeAudio({
      audio: Buffer.alloc(10 * 1024 * 1024 + 1),
      mimeType: "audio/ogg",
      instanceSlug: "demo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });

  it("rejects audio longer than 60 seconds when duration is known", async () => {
    const result = await transcribeAudio({
      audio: Buffer.from([0]),
      mimeType: "audio/ogg",
      durationSec: 61,
      instanceSlug: "demo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_long");
  });

  it("returns provider_error when credentials are missing", async () => {
    resolveInstanceConfigMock.mockResolvedValue({
      stt: { provider: "openai", credentials: {} },
    });
    const result = await transcribeAudio({
      audio: Buffer.from([0]),
      mimeType: "audio/ogg",
      instanceSlug: "demo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("provider_error");
  });

  it("returns stt_disabled without calling the gateway when the provider is disabled", async () => {
    resolveInstanceConfigMock.mockResolvedValue({
      stt: { provider: "disabled", credentials: {} },
    });
    const result = await transcribeAudio({
      audio: Buffer.from([0]),
      mimeType: "audio/ogg",
      instanceSlug: "demo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("stt_disabled");
      expect(result.userReply).toBe("Voice messages are not supported. Please type your message instead.");
    }
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("returns the transcript and metadata on success", async () => {
    transcribeMock.mockResolvedValue({
      text: "ciao mondo",
      language: "it",
      durationSec: 4.2,
      provider: "openai",
      model: "whisper-1",
      latencyMs: 800,
    });

    const result = await transcribeAudio({
      audio: Buffer.from([0]),
      mimeType: "audio/ogg",
      durationSec: 4,
      instanceSlug: "demo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("ciao mondo");
      expect(result.metadata).toEqual({
        originalKind: "audio",
        durationSec: 4.2,
        sttProvider: "openai",
        language: "it",
      });
      expect(result.latencyMs).toBe(800);
    }
  });

  it("returns empty_transcript when the gateway returns whitespace only", async () => {
    transcribeMock.mockResolvedValue({
      text: "   ",
      provider: "openai",
      model: "whisper-1",
      latencyMs: 400,
    });

    const result = await transcribeAudio({
      audio: Buffer.from([0]),
      mimeType: "audio/ogg",
      instanceSlug: "demo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_transcript");
  });

  it("maps STTUnsupportedFormatError to unsupported_format", async () => {
    const { STTUnsupportedFormatError } = await import("../stt-gateway/errors.js");
    transcribeMock.mockRejectedValue(new STTUnsupportedFormatError("aws", "audio/mpeg"));

    const result = await transcribeAudio({
      audio: Buffer.from([0]),
      mimeType: "audio/mpeg",
      instanceSlug: "demo",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_format");
  });
});
