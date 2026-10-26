// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one spelling of the placeholder that stands in for a secret in an API
 * response, and the one rule for what stays visible next to it.
 *
 * The prefix must stay constant: the write paths recognise it
 * (`isMaskedPlaceholder`) to avoid saving the placeholder over the real secret.
 */
export const MASK = "••••";

/** Whether a value a client sent back is the placeholder (or starts with it), not a new secret. */
export function isMaskedPlaceholder(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(MASK);
}

/**
 * A secret as an API response shows it. Long values keep a last-4 hint; values
 * of 8 characters or fewer are hidden fully, so the hint cannot leak most of a
 * short secret.
 */
export function maskSecret(value: string): string {
  return value.length > 8 ? MASK + value.slice(-4) : MASK;
}
