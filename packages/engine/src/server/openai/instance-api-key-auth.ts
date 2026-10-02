// SPDX-License-Identifier: AGPL-3.0-or-later

import { UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { findInstanceBySlug } from "../../instances/store.js";
import { resolveInstanceConfig } from "../../instances/config-resolver.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

/**
 * A turn on a web route (`/v1/chat/completions`, chat/stream).
 *
 * Call context is projected onto the conversation state keyed by the
 * caller-chosen `chat_id`, and every later turn of that conversation loads it:
 * tools then act on whoever the context named. So a request carrying context
 * needs the key, and so does EVERY web turn on an agent that maps context
 * fields — otherwise anyone who learnt a `chat_id` could continue the
 * conversation without the key and act as the identity a keyed request put
 * there. Checked here, per request, rather than when the mapping is saved:
 * that holds whatever order the switch, the mapping and an import are changed in.
 */
export interface WebTurn {
  /** The request carries call `context`, which writes conversation state. */
  carriesContext: boolean;
}

/**
 * Per-instance API key authentication for chat endpoints.
 *
 * Used by both `POST /v1/chat/completions` (OpenAI-compatible) and
 * `POST /api/instances/:slug/chat/stream` (admin playground typed SSE).
 * Both endpoints are marked `@Public()` so the global JWT `AuthGuard` is
 * skipped — they identify the caller via the instance slug + a Bearer token
 * matched against the secret stored in `instance_secrets.auth_api_key`.
 *
 * Throws `UnauthorizedException`:
 *  - "Unknown model"                          slug not found
 *  - "Auth enabled but no API key configured" `authEnabled` true, secret missing
 *  - "Missing Bearer token"                   header absent / wrong scheme
 *  - "Invalid API key"                        timing-safe comparison failed
 *
 * When `authEnabled` is false the function returns silently — open access —
 * unless the request is a web turn on an agent that maps web context (see
 * `WebTurn`), which needs the agent's key even on an open agent.
 */
export async function validateInstanceApiKey(
  instanceSlug: string,
  authHeader?: string,
  webTurn?: WebTurn,
): Promise<void> {
  const slug = asInstanceSlug(instanceSlug);
  const instance = await findInstanceBySlug(slug);
  if (!instance) {
    throw new UnauthorizedException("Unknown model");
  }

  const instanceConfig = await resolveInstanceConfig(slug);
  const mapsWebContext = Object.keys(instanceConfig.webContextFieldMapping ?? {}).length > 0;
  const requireKey = webTurn !== undefined && (webTurn.carriesContext || mapsWebContext);
  // Ordinary chat may be open; a turn that can read or write mapped context may not.
  if (!instanceConfig.authEnabled && !requireKey) return;

  if (!instanceConfig.authApiKey) {
    throw new UnauthorizedException(requireKey && !instanceConfig.authEnabled
      ? "Call context requires the agent's API key" : "Auth enabled but no API key configured");
  }

  if (!authHeader?.startsWith("Bearer ")) {
    throw new UnauthorizedException("Missing Bearer token");
  }

  const token = authHeader.slice(7);
  const expected = instanceConfig.authApiKey;
  const tokBuf = Buffer.from(token, "utf-8");
  const expBuf = Buffer.from(expected, "utf-8");
  if (tokBuf.length !== expBuf.length || !timingSafeEqual(tokBuf, expBuf)) {
    throw new UnauthorizedException("Invalid API key");
  }
}
