// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-org sign-in domain allowlist (RBAC Stream 8 — OSS path).
 *
 * OSS supports a single configurable allowed domain per deployment via the
 * `AUTH_ALLOWED_DOMAIN` env var (one domain = one org in the single-org OSS
 * model). The legacy plural `AUTH_ALLOWED_DOMAINS` (comma-separated) is still
 * honoured and merged in, so existing deployments keep working. When neither
 * is set the allowlist is empty and every domain is allowed (open OSS default).
 *
 * EE layers a per-org allowlist table + UI on top of this; that is out of scope
 * for the OSS path. There is intentionally NO hardcoded domain here — every
 * tenant is configured purely through env, so any customer can onboard.
 */

/**
 * Collect the configured allowed domains from env, lowercased and de-duplicated.
 * Reads both the singular `AUTH_ALLOWED_DOMAIN` (OSS, 1 domain/org) and the
 * legacy plural `AUTH_ALLOWED_DOMAINS` (comma-separated).
 */
export function parseAllowedDomains(): string[] {
  const raw = [
    process.env.AUTH_ALLOWED_DOMAIN ?? "",
    process.env.AUTH_ALLOWED_DOMAINS ?? "",
  ].join(",");

  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const domain = entry.trim().toLowerCase();
    if (domain) seen.add(domain);
  }
  return [...seen];
}

/**
 * Decide whether an email's domain is permitted to sign in.
 *
 * - Empty allowlist → allow any email (open default).
 * - Non-empty allowlist → the email's domain part must EXACTLY equal one of the
 *   allowed domains. Matching is case-insensitive and on the exact domain, so
 *   look-alikes such as `evilacme.com` or `acme.com.evil.io` are rejected even
 *   though they share a textual suffix/prefix with `acme.com`.
 */
export function isEmailDomainAllowed(
  email: string | null | undefined,
  allowList: readonly string[],
): boolean {
  if (allowList.length === 0) return true;

  const normalized = (email ?? "").trim().toLowerCase();
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex < 0) return false;

  const domain = normalized.slice(atIndex + 1);
  if (!domain) return false;

  return allowList.includes(domain);
}
