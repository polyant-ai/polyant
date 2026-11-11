// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Database error helpers.
 *
 * Drizzle 0.45 (postgres-js driver) wraps the underlying `PostgresError` inside
 * a `DrizzleQueryError`. The driver-level error — which carries the SQLSTATE
 * `code` (e.g. "23505" for unique violation) — ends up on `err.cause`, not on
 * `err` itself. We therefore have to inspect BOTH levels.
 */

const UNIQUE_VIOLATION_CODE = "23505";
const FOREIGN_KEY_VIOLATION_CODE = "23503";

function hasCode(value: unknown, code: string): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    "code" in value &&
    (value as { code: unknown }).code === code
  );
}

function hasSqlState(err: unknown, code: string): boolean {
  if (!(err instanceof Error)) return false;
  if (hasCode(err, code)) return true;
  // postgres-js wraps the underlying PostgresError on .cause
  return hasCode((err as Error & { cause?: unknown }).cause, code);
}

/** Detect a PostgreSQL unique constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, UNIQUE_VIOLATION_CODE);
}

/** Detect a PostgreSQL foreign key violation (SQLSTATE 23503): the referenced row does not exist. */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasSqlState(err, FOREIGN_KEY_VIOLATION_CODE);
}
