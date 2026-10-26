// SPDX-License-Identifier: AGPL-3.0-or-later

import type { STTProviderAdapter, STTRequest, STTResponse } from "../types.js";
import { STTMissingCredentialsError } from "../errors.js";
import { sttFetch } from "../stt-fetch.js";

const DEFAULT_MODEL = "nova-3";

async function transcribe(req: STTRequest): Promise<STTResponse> {
  const cred = req.credentials.deepgram;
  if (!cred?.apiKey) throw new STTMissingCredentialsError("deepgram");

  const model = cred.model ?? DEFAULT_MODEL;
  const params = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
  });
  if (req.languageHint) params.set("language", req.languageHint);
  else params.set("detect_language", "true");

  const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;

  const start = Date.now();
  const res = await sttFetch(
    "deepgram",
    url,
    {
      method: "POST",
      headers: { Authorization: `Token ${cred.apiKey}`, "Content-Type": req.mimeType },
      body: req.audio,
    },
    req,
  );

  type DeepgramResponse = {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string; confidence?: number }>;
        detected_language?: string;
      }>;
    };
    metadata?: { duration?: number };
  };
  const json = (await res.json()) as DeepgramResponse;

  const channel = json.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];

  return {
    text: (alt?.transcript ?? "").trim(),
    language: channel?.detected_language ?? req.languageHint,
    durationSec: typeof json.metadata?.duration === "number" ? json.metadata.duration : undefined,
    confidence: typeof alt?.confidence === "number" ? alt.confidence : undefined,
    provider: "deepgram",
    model,
    latencyMs: Date.now() - start,
  };
}

export const deepgramAdapter: STTProviderAdapter = {
  name: "deepgram",
  transcribe,
};
