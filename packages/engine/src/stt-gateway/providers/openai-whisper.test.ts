// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openAIWhisperAdapter } from "./openai-whisper.js";
import { STTProviderError, STTMissingCredentialsError } from "../errors.js";

describe("openAIWhisperAdapter", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("returns a normalized transcript on a successful Whisper response", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(
        JSON.stringify({
          text: "ciao mondo",
          language: "italian",
          duration: 3.42,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await openAIWhisperAdapter.transcribe({
      audio: Buffer.from([0x4f, 0x67, 0x67, 0x53]), // "OggS"
      mimeType: "audio/ogg",
      credentials: { openai: { apiKey: "sk-test", model: "whisper-1" } },
    });

    expect(result.text).toBe("ciao mondo");
    expect(result.language).toBe("italian");
    expect(result.durationSec).toBeCloseTo(3.42);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("whisper-1");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("throws STTMissingCredentialsError when credentials.openai is undefined", async () => {
    await expect(
      openAIWhisperAdapter.transcribe({
        audio: Buffer.from([0]),
        mimeType: "audio/ogg",
        credentials: {},
      }),
    ).rejects.toBeInstanceOf(STTMissingCredentialsError);
  });

  it("throws STTProviderError on non-2xx response", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ error: "bad audio" }), { status: 400 }),
    );

    await expect(
      openAIWhisperAdapter.transcribe({
        audio: Buffer.from([0]),
        mimeType: "audio/ogg",
        credentials: { openai: { apiKey: "sk-test" } },
      }),
    ).rejects.toBeInstanceOf(STTProviderError);
  });

  it("uses default model 'whisper-1' when none provided", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ text: "x" }), { status: 200 }),
    );

    const result = await openAIWhisperAdapter.transcribe({
      audio: Buffer.from([0]),
      mimeType: "audio/ogg",
      credentials: { openai: { apiKey: "sk-test" } },
    });

    expect(result.model).toBe("whisper-1");
    const fetchCall = (global.fetch as any).mock.calls[0];
    const formData: FormData = fetchCall[1].body;
    expect(formData.get("model")).toBe("whisper-1");
  });
  it("removes its listener from the caller's abort signal once the request settles", async () => {
    (global.fetch as any).mockResolvedValue(new Response('{"text":"x"}', { status: 200 }));
    const caller = new AbortController();
    const added = vi.spyOn(caller.signal, "addEventListener");
    const removed = vi.spyOn(caller.signal, "removeEventListener");

    await openAIWhisperAdapter.transcribe({
      audio: Buffer.from([0]),
      mimeType: "audio/ogg",
      credentials: { openai: { apiKey: "k" } },
      abortSignal: caller.signal,
    });

    const [, listener] = added.mock.calls.find(([type]) => type === "abort")!;
    expect(removed).toHaveBeenCalledWith("abort", listener);
  });
});
