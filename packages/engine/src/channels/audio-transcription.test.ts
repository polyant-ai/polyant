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

import { transcribeAudio, transcribeInbound } from "./audio-transcription.js";
import { STTProviderError, STTTimeoutError } from "../stt-gateway/errors.js";
import { aiLogger } from "../ai-gateway/logger.js";

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

  it("logs the cost of an empty transcript, since the provider billed the audio", async () => {
    const logSpy = vi.spyOn(aiLogger, "log").mockImplementation(() => undefined);
    transcribeMock.mockResolvedValue({
      text: "",
      durationSec: 30,
      provider: "openai",
      model: "whisper-1",
      latencyMs: 400,
    });

    const result = await transcribeAudio({
      audio: Buffer.from([0]),
      mimeType: "audio/ogg",
      instanceSlug: "demo",
      conversationId: "c1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_transcript");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0].estimatedCostUsd).toBeGreaterThan(0);
    logSpy.mockRestore();
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

  it("reports a timeout from the timeout error type", async () => {
    transcribeMock.mockRejectedValue(new STTTimeoutError("openai", 30_000));
    const result = await transcribeAudio({ audio: Buffer.from([0]), mimeType: "audio/ogg", instanceSlug: "demo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });

  it("does not read a timeout into a provider error whose message mentions an abort", async () => {
    // The provider's own text (an HTTP body, say) is not a signal of what happened.
    transcribeMock.mockRejectedValue(new STTProviderError("openai", "HTTP 400: request aborted"));
    const result = await transcribeAudio({ audio: Buffer.from([0]), mimeType: "audio/ogg", instanceSlug: "demo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("provider_error");
  });
});

describe("transcribeInbound", () => {
  beforeEach(() => {
    resolveInstanceConfigMock.mockReset();
    transcribeMock.mockReset();
    resolveInstanceConfigMock.mockResolvedValue(FAKE_OPENAI_CONFIG);
  });

  const clip = { audio: Buffer.from([0]), mimeType: "audio/ogg" };

  it("appends each transcript on its own line and reports the audio metadata", async () => {
    transcribeMock
      .mockResolvedValueOnce({ text: "uno", language: "it", durationSec: 1, provider: "openai", model: "whisper-1", latencyMs: 10 })
      .mockResolvedValueOnce({ text: "due", language: "it", durationSec: 2, provider: "openai", model: "whisper-1", latencyMs: 20 });

    const result = await transcribeInbound({ instanceSlug: "demo", conversationId: "demo:x:1", text: "ciao", clips: [clip, clip] });

    expect(result).toEqual({
      ok: true,
      text: "ciao\nuno\ndue",
      metadata: {
        originalKind: "audio",
        audio: { originalKind: "audio", durationSec: 2, sttProvider: "openai", language: "it", latencyMs: 20 },
      },
    });
  });

  it("uses the transcript alone when the message has no text", async () => {
    transcribeMock.mockResolvedValue({ text: "solo audio", provider: "openai", model: "whisper-1", latencyMs: 5 });
    const result = await transcribeInbound({ instanceSlug: "demo", conversationId: "demo:x:1", text: "", clips: [clip] });
    expect(result.ok && result.text).toBe("solo audio");
  });

  it("stops at the first failure and returns the reply to send", async () => {
    transcribeMock.mockRejectedValue(new STTProviderError("openai", "boom"));
    const result = await transcribeInbound({ instanceSlug: "demo", conversationId: "demo:x:1", text: "", clips: [clip, clip] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reply.length).toBeGreaterThan(0);
    expect(transcribeMock).toHaveBeenCalledTimes(1);
  });
});
