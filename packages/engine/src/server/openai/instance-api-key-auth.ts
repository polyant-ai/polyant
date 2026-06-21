// SPDX-License-Identifier: AGPL-3.0-or-later

import { UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { findInstanceBySlug } from "../../instances/store.js";
import { resolveInstanceConfig } from "../../instances/config-resolver.js";
import { asAgentSlug } from "../../instances/identifiers.js";

/**
 * Per-instance API key authentication for chat endpoints.
 *
 * Used by both `POST /v1/chat/completions` (OpenAI-compatible) and
 * `POST /api/agents/:slug/chat/stream` (admin playground typed SSE).
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
 * When `authEnabled` is false the function returns silently — open access.
 */
export async function validateInstanceApiKey(
  instanceSlug: string,
  authHeader?: string,
): Promise<void> {
  const slug = asAgentSlug(instanceSlug);
  const instance = await findInstanceBySlug(slug);
  if (!instance) {
    throw new UnauthorizedException("Unknown model");
  }

  const instanceConfig = await resolveInstanceConfig(slug);
  if (!instanceConfig.authEnabled) return; // Auth not enabled = open access

  if (!instanceConfig.authApiKey) {
    throw new UnauthorizedException("Auth enabled but no API key configured");
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
