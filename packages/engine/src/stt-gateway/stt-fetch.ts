// SPDX-License-Identifier: AGPL-3.0-or-later

import type { STTProviderName, STTRequest } from "./types.js";
import { STTProviderError, STTTimeoutError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run one transcription under the request's timeout and the caller's abort
 * signal, from the request to the last byte of the answer. `work` gets the
 * signal to hand its transport; it is also raced, so a transport or a body
 * that ignores the signal still cannot hold the caller past the deadline.
 * A timeout becomes `STTTimeoutError`, a caller abort an `STTProviderError`.
 *
 * The caller's listener is removed once the work settles, so a long-lived
 * signal does not accumulate one per transcription.
 */
export async function withSttDeadline<T>(
  provider: STTProviderName,
  req: STTRequest,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
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
  if (req.abortSignal?.aborted) controller.abort();
  req.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  // The race may settle on the work first; the loser's rejection is expected.
  stopped.catch(() => undefined);

  try {
    return await Promise.race([work(controller.signal), stopped]);
  } catch (err) {
    if (controller.signal.aborted) {
      if (timedOut) throw new STTTimeoutError(provider, timeoutMs);
      throw new STTProviderError(provider, "aborted by the caller", { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    req.abortSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * POST an HTTP transcription request and parse its answer under
 * `withSttDeadline`, mapping a transport failure and a non-2xx answer (with
 * the body in the message) to the gateway's errors.
 */
export async function sttFetch<T>(
  provider: STTProviderName,
  url: string,
  init: Omit<RequestInit, "signal">,
  req: STTRequest,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  return withSttDeadline(provider, req, async (signal) => {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new STTProviderError(provider, `fetch failed: ${(err as Error).message}`, { cause: err });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new STTProviderError(provider, `HTTP ${res.status}: ${body}`, { status: res.status });
    }
    return parse(res);
  });
}
