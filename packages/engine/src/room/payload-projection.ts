// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reduce a webhook payload for the prompt, not for storage.
 *
 * The room's synthetic message IS the user turn, so it is re-sent on every step
 * of the turn. A GitHub payload carries tens of API URL templates per object —
 * `events_url`, `stargazers_url`, `notifications_url` and the rest — plus the
 * node/gravatar ids. No interpretation prompt can act on them, and they are
 * paid for 7-11 times in a single cycle and counted against the context budget
 * the engine displays at the top of the same message.
 *
 * The reduction is subtractive and applies to known source types only. A
 * projection that listed the fields to KEEP would silently drop whatever an
 * integration sends that the list does not anticipate; dropping named noise
 * cannot. `html_url` survives on purpose — it is the one URL an agent writes
 * into a reply.
 *
 * The raw payload stays intact in `event_backlog`: this touches the rendered
 * copy only, so replay and debugging still see what arrived.
 */

/** Keys dropped anywhere in a GitHub payload. */
const GITHUB_NOISE_KEYS = new Set([
  "url",
  "node_id",
  "gravatar_id",
  "avatar_url",
  "performed_via_github_app",
]);

function isGithubNoise(key: string): boolean {
  if (GITHUB_NOISE_KEYS.has(key)) return true;
  // API URL templates: every object carries a dozen. `html_url` is the human one.
  return key.endsWith("_url") && key !== "html_url";
}

function prune(value: unknown, drop: (key: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => prune(v, drop));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (drop(key)) continue;
    out[key] = prune(val, drop);
  }
  return out;
}

/**
 * The payload as it should appear in the prompt. Unknown source types pass
 * through unchanged, so an integration this module does not know about can
 * never lose a field.
 */
export function projectEventPayload(sourceType: string | undefined, payload: unknown): unknown {
  if (sourceType?.trim().toLowerCase() === "github") {
    return prune(payload, isGithubNoise);
  }
  return payload;
}
