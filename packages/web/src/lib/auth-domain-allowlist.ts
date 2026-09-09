// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The matching rule for a sign-in domain allowlist.
 *
 * It used to be fed by `AUTH_ALLOWED_DOMAIN` / `AUTH_ALLOWED_DOMAINS`, two env
 * vars that were the same thing twice — the parser concatenated them and split
 * on commas, so the singular already accepted a list. Both are gone: which
 * domains may sign in is per-ORGANIZATION configuration, not a property of the
 * deployment, and one list for a whole installation cannot answer it for a
 * second tenant. This module keeps the comparison and nothing else, so the tier
 * that owns the list decides where the list comes from.
 */

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
