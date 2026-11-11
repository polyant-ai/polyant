// SPDX-License-Identifier: AGPL-3.0-or-later

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is written as a UUID, in either case. Checked before a value
 * reaches a uuid column: Postgres rejects a malformed one with an error, where
 * the caller only sent a bad id.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
