// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";

/**
 * WHO a throttle bucket belongs to.
 *
 * The throttler's default tracker is `req.ip`, and in this project's standard
 * topology that is ONE address for every human being: the panel proxies
 * `/api/*` to the engine through its own container (Next rewrites, see
 * `packages/web/next.config.ts`), and Express `trust proxy` is 0 by default
 * (`config.server.trustProxy`), so `X-Forwarded-For` is ignored. Two real
 * consequences:
 *
 *   - `/api/auth/credentials/verify` is called SERVER-TO-SERVER on every sign-in,
 *     so its 5/min bucket was deployment-wide: five wrong passwords in a minute
 *     and NOBODY could log in. A rate limit whose failure mode is denial of
 *     service to every account at once is not protecting anything.
 *   - The same collapse made the limit useless as brute-force protection, since
 *     an attacker shares one budget with — and is masked by — real traffic.
 *
 * Turning `TRUST_PROXY` on does not fix it. `req.ip` then becomes the leftmost
 * `X-Forwarded-For` entry, which the CLIENT supplies: rotate the header and the
 * limit is gone. It also has a separate job (the Twilio HMAC is computed over
 * the externally-visible URL), so it is the wrong knob to reach for here.
 *
 * So the bucket is keyed by the thing being protected rather than by the network
 * path: the ACCOUNT for a credential-bearing form, the SESSION for an
 * authenticated caller, the API KEY for a machine one, and only then the address.
 * Every value is hashed — a bucket key lives in memory and can reach a log line,
 * and an email or a session token does not belong there.
 *
 * Trade-off, stated plainly: an account-keyed login bucket lets a third party
 * spend a victim's five attempts per minute. That is the standard shape, it
 * recovers on its own the next minute, and the alternative it replaces failed
 * exactly that way for EVERY account simultaneously.
 *
 * Deliberately NOT here: a `token`-in-body branch. No endpoint in this build
 * takes a bearer-ish token in a request body, so such a branch would be a
 * lookalike for a case that cannot occur — add it with the flow that needs it.
 *
 * Per-process counters, like the throttler's own store. A distributed limiter
 * (Redis) is the upgrade a horizontally-scaled deployment needs for the limit to
 * hold across pods; today each pod enforces its own.
 */

const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

/** Keep the subject out of the key: buckets are held in memory and can be logged. */
function digest(label: string, value: string): string {
  return `${label}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

/** The subset of an Express request this needs. Structural, so tests need no app. */
interface TrackableRequest {
  ip?: string;
  body?: unknown;
  headers?: Record<string, unknown>;
  cookies?: Record<string, string | undefined>;
  socket?: { remoteAddress?: string };
}

function bearerToken(headers: Record<string, unknown> | undefined): string | undefined {
  const raw = headers?.authorization;
  if (typeof raw !== "string") return undefined;
  const [scheme, token] = raw.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

export function throttleTracker(req: TrackableRequest): string {
  // Most specific first: a credential form names the account it is guessing at.
  const email = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof email === "string" && email.trim()) {
    return digest("account", email.trim().toLowerCase());
  }

  const managementKey = req.headers?.["x-polyant-key"];
  if (typeof managementKey === "string" && managementKey) {
    return digest("key", managementKey);
  }

  const session =
    bearerToken(req.headers) ??
    SESSION_COOKIES.map((name) => req.cookies?.[name]).find((value) => !!value);
  if (session) return digest("session", session);

  // Anonymous and unidentified: the address is all there is. This is the branch
  // the whole file exists to make RARE, not the one it removes.
  return `ip:${req.ip ?? req.socket?.remoteAddress ?? "unknown"}`;
}
