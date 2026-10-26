// SPDX-License-Identifier: AGPL-3.0-or-later

import type { STTProviderAdapter, STTRequest, STTResponse } from "../types.js";
import { STTMissingCredentialsError } from "../errors.js";
import { sttFetch } from "../stt-fetch.js";

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

  const start = Date.now();
  const res = await sttFetch(
    "openai",
    ENDPOINT,
    { method: "POST", headers: { Authorization: `Bearer ${cred.apiKey}` }, body: form },
    req,
  );

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
