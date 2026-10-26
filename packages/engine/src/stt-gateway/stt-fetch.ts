// SPDX-License-Identifier: AGPL-3.0-or-later

import type { STTProviderName, STTRequest } from "./types.js";
import { STTProviderError, STTTimeoutError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * POST an HTTP transcription request under the request's timeout and the
 * caller's abort signal, and map every failure to the gateway's errors: a
 * timeout, a caller abort, a transport failure, and a non-2xx answer (with the
 * body in the message). Returns the OK response for the adapter to parse.
 *
 * The caller's listener is removed once the request settles, so a long-lived
 * signal does not accumulate one per transcription.
 */
export async function sttFetch(
  provider: STTProviderName,
  url: string,
  init: Omit<RequestInit, "signal">,
  req: STTRequest,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Told apart from a caller's abort by this flag, not by the error text: both arrive
  // as the same AbortError.
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  req.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      if (timedOut) throw new STTTimeoutError(provider, timeoutMs);
      throw new STTProviderError(provider, "aborted by the caller", { cause: err });
    }
    throw new STTProviderError(provider, `fetch failed: ${(err as Error).message}`, { cause: err });
  } finally {
    clearTimeout(timeoutId);
    req.abortSignal?.removeEventListener("abort", onCallerAbort);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new STTProviderError(provider, `HTTP ${res.status}: ${body}`, { status: res.status });
  }
  return res;
}
