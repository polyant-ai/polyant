// SPDX-License-Identifier: AGPL-3.0-or-later

/** Extract a human-readable message from an unknown caught value. */
export function errMsg(err: unknown): string {
  // eslint-disable-next-line no-restricted-syntax -- this is the implementation the rule points to
  return err instanceof Error ? err.message : String(err);
}
