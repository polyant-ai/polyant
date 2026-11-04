// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When a send to Twilio may be made again. Twilio's Messages API takes no
 * idempotency key, so a send is repeated only when Twilio certainly did not
 * take it: rate-limited (429), refused as unavailable (503), or never reached.
 * Anything else (500, 502, 504, a read timeout, a reset after sending) may have
 * queued the message, and a resend would deliver it twice: it fails as it came.
 *
 * The rule is shared by every caller that sends to Twilio, through the SDK or
 * with fetch; each caller only says how its own outcome reads.
 */

/** Waits before the second and third attempt of a send Twilio did not take. */
export const SEND_RETRY_DELAYS_MS: readonly number[] = [300, 1_200];
/** The longest wait a `Retry-After` may ask for; past it the send fails at once. */
export const SEND_RETRY_MAX_WAIT_MS = 5_000;

/**
 * Network errors raised before any byte of the request left: the message
 * cannot have reached Twilio. A reset, a TLS failure or a timeout is left out,
 * since neither the SDK nor fetch tells whether the request was already sent.
 */
const NOT_SENT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/** An HTTP status with which Twilio did not take the send: 429 or 503. */
export function isNotTakenStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** A network error code raised before the request left. */
export function isNotSentErrorCode(code: unknown): boolean {
  return typeof code === "string" && NOT_SENT_ERROR_CODES.has(code);
}

/** `Retry-After` in milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** One attempt's outcome: what `send` resolved to, or what it threw. */
export type SendOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A send Twilio did not take, with the wait it asked for and what to free before sending again. */
export interface NotTakenSend {
  retryAfterMs?: number;
  discard?: () => Promise<unknown>;
}

/**
 * Runs `send`, and runs it again at most twice when `notTaken` reads the
 * outcome as a send Twilio did not take. A wait `Retry-After` puts past the cap
 * ends the retries at once. When the retries end, the last outcome is returned
 * or thrown as it came.
 */
export async function retryNotTakenSend<T>(
  send: () => Promise<T>,
  notTaken: (outcome: SendOutcome<T>) => NotTakenSend | undefined,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let outcome: SendOutcome<T>;
    try {
      outcome = { ok: true, value: await send() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const delay = SEND_RETRY_DELAYS_MS[attempt];
    const refused = delay === undefined ? undefined : notTaken(outcome);
    if (delay !== undefined && refused) {
      const wait = Math.max(delay, refused.retryAfterMs ?? 0);
      if (wait <= SEND_RETRY_MAX_WAIT_MS) {
        await refused.discard?.().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
    }
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }
}
