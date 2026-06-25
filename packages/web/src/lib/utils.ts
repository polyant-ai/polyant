// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Returns true iff `icon` is safe to use as a remote/static image `src`.
 *
 * Only two shapes are accepted:
 *   - `https://...`              — explicit absolute HTTPS URL
 *   - `/path/to/icon`            — same-origin relative path (NOT `//host`,
 *                                  which would be a protocol-relative URL)
 *
 * Everything else is rejected, including `data:`, `http:`, `javascript:`,
 * `blob:`, etc.  This is the rendering-time guard for values that may
 * have been stored in the DB by a user (e.g. `instance.icon`).
 *
 * The engine API already returns `instance.icon` as a `/api/agents/<slug>/icon?v=...`
 * relative URL, so the legitimate path is preserved.  Raw `data:` URIs are
 * only valid in transient local-preview contexts (e.g. canvas output before
 * upload) and must NOT use this guard.
 */
export function isSafeImageSrc(icon: string): boolean {
  if (icon.startsWith("https://")) return true;
  // Same-origin relative path, but reject `//host` (protocol-relative URL).
  if (icon.startsWith("/") && !icon.startsWith("//")) return true;
  return false;
}
