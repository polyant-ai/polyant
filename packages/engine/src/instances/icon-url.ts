// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Build the public URL that serves an instance icon.
 *
 * Icons are stored in the DB as `data:image/...;base64,...` URIs, but they are
 * NEVER put on the wire as data URIs: the web guard `isSafeImageSrc` rejects
 * `data:` to prevent an attacker who can edit `instance.icon` from smuggling an
 * SVG-with-<script> that fires when the icon is broadcast (e.g. over the
 * activity SSE stream). Both the REST DTO and the activity-stream emitters MUST
 * use this single helper so the two paths can never drift — that drift was the
 * root cause of base64 icons leaking through as raw text.
 *
 * The binary is served by `GET /api/agents/:slug/icon`. A cache-busting
 * `v=<updatedAt>` query param makes the browser reload after an icon change.
 *
 * Returns null when the instance has no icon, so callers can render a fallback.
 */
export function buildInstanceIconUrl(
  slug: string,
  icon: string | null,
  updatedAt: Date | null,
): string | null {
  if (!icon) return null;
  return `/api/agents/${slug}/icon?v=${updatedAt?.getTime() ?? 0}`;
}
