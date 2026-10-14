// SPDX-License-Identifier: AGPL-3.0-or-later

import type { STTProviderAdapter, STTRequest, STTResponse } from "../types.js";
import { STTMissingCredentialsError, STTProviderError, STTTimeoutError } from "../errors.js";

const DEFAULT_MODEL = "whisper-1";
const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

async function transcribe(req: STTRequest): Promise<STTResponse> {
  const cred = req.credentials.openai;
  if (!cred?.apiKey) throw new STTMissingCredentialsError("openai");

  const model = cred.model ?? DEFAULT_MODEL;
  const fileName = req.mimeType === "audio/mpeg" ? "audio.mp3" : "audio.ogg";

  const form = new FormData();
  form.append("file", new Blob([req.audio], { type: req.mimeType }), fileName);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  if (req.languageHint) form.append("language", req.languageHint);

  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? 30_000;
  // Told apart from a caller's abort by this flag, not by the error text: both arrive
  // as the same AbortError.
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (req.abortSignal) {
    req.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${cred.apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      if (timedOut) throw new STTTimeoutError("openai", timeoutMs);
      throw new STTProviderError("openai", "aborted by the caller", { cause: err });
    }
    throw new STTProviderError("openai", `fetch failed: ${(err as Error).message}`, { cause: err });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new STTProviderError("openai", `HTTP ${res.status}: ${body}`, { status: res.status });
  }

  const json = (await res.json()) as { text?: string; language?: string; duration?: number };

  return {
    text: (json.text ?? "").trim(),
    language: json.language,
    durationSec: typeof json.duration === "number" ? json.duration : undefined,
    provider: "openai",
    model,
    latencyMs: Date.now() - start,
  };
}

export const openAIWhisperAdapter: STTProviderAdapter = {
  name: "openai",
  transcribe,
};
