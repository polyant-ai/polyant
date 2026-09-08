// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { TtlCache } from "../utils/ttl-cache.js";

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
 * A CALLER-SUPPLIED credential cannot be the whole story, though: nothing here
 * verifies it, so an anonymous caller rotating `Authorization: Bearer <random>`
 * would mint a fresh, empty bucket per request — on `/v1/chat/completions`,
 * `/a2a/:slug/jsonrpc` and the chat-stream routes, where the throttle is the
 * only declared mitigation and `validateInstanceApiKey` returns silently while
 * `authEnabled` is off. Each distinct value also allocated a store record for
 * the whole TTL, so the rotation grew memory as it went. Hence the cardinality
 * cap below: the machine branches (bearer, management key) let one address
 * claim only so many distinct credentials inside a window, and past that its
 * bucket collapses to the address. A real machine caller presents one or two
 * keys; a rotator presents thousands.
 *
 * The cap deliberately does NOT cover the session cookie: those arrive through
 * the panel's proxy, so a high count of distinct sessions per address is the
 * normal shape there and capping it would resurrect the deployment-wide denial
 * this file exists to remove.
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

/**
 * Distinct machine credentials one address may claim inside a window before its
 * bucket collapses to the address. Sized for a real caller (one key, maybe a
 * rotation overlap), not for a rotator.
 */
const MAX_MACHINE_CREDENTIALS_PER_ADDRESS = 20;

/** address -> the machine-credential buckets it has already claimed this window. */
const machineCredentialsByAddress = new TtlCache<string, Set<string>>({
  maxSize: 10_000,
  ttlMs: 60_000,
});

function addressOf(req: TrackableRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * Bucket for an UNVERIFIED machine credential: its own, until the address has
 * claimed more distinct ones than a real caller ever would — then the address.
 */
function machineCredentialBucket(req: TrackableRequest, label: string, value: string): string {
  const address = addressOf(req);
  const bucket = digest(label, value);

  const seen = machineCredentialsByAddress.get(address);
  if (!seen) {
    machineCredentialsByAddress.set(address, new Set([bucket]));
    return bucket;
  }
  if (seen.has(bucket)) return bucket;
  if (seen.size >= MAX_MACHINE_CREDENTIALS_PER_ADDRESS) return `ip:${address}`;

  seen.add(bucket);
  machineCredentialsByAddress.set(address, seen); // refresh the window
  return bucket;
}

/** Drop the per-address cardinality state. Tests only. */
export function resetThrottleTrackerState(): void {
  machineCredentialsByAddress.clear();
}

export function throttleTracker(req: TrackableRequest): string {
  // Most specific first: a credential form names the account it is guessing at.
  const email = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof email === "string" && email.trim()) {
    return digest("account", email.trim().toLowerCase());
  }

  const managementKey = req.headers?.["x-polyant-key"];
  if (typeof managementKey === "string" && managementKey) {
    return machineCredentialBucket(req, "key", managementKey);
  }

  const bearer = bearerToken(req.headers);
  if (bearer) return machineCredentialBucket(req, "session", bearer);

  const cookie = SESSION_COOKIES.map((name) => req.cookies?.[name]).find((value) => !!value);
  if (cookie) return digest("session", cookie);

  // Anonymous and unidentified: the address is all there is. This is the branch
  // the whole file exists to make RARE, not the one it removes.
  return `ip:${addressOf(req)}`;
}
