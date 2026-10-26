// SPDX-License-Identifier: AGPL-3.0-or-later

// RFC 5321 caps an email address at 254 chars. Enforce it before the regex
// runs so the polynomial-ish backtracking cost of the [^\s@]+ groups can
// never be triggered by an attacker-supplied long string (CodeQL js/polynomial-redos).
export const EMAIL_MAX_LEN = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The trimmed, lower-cased address, or `null` when it is not a plausible email.
 * The one rule every account-creating path (user create, registration,
 * invitation) applies, so an address accepted by one is accepted by all.
 */
export function normalizeEmail(raw: string | undefined | null): string | null {
  const email = (raw ?? "").trim().toLowerCase();
  if (email.length > EMAIL_MAX_LEN || !EMAIL_RE.test(email)) return null;
  return email;
}
