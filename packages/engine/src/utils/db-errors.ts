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

/**
 * The SQLSTATE of a Postgres error: read from the error itself or from the
 * `cause` chain drizzle and postgres-js wrap it in. Undefined when the error
 * carries none (a connection error's code, such as ECONNREFUSED, is not one).
 */
export function sqlState(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function hasSqlState(err: unknown, code: string): boolean {
  return err instanceof Error && sqlState(err) === code;
}

/** Detect a PostgreSQL unique constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, UNIQUE_VIOLATION_CODE);
}

/** Detect a PostgreSQL foreign key violation (SQLSTATE 23503): the referenced row does not exist. */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasSqlState(err, FOREIGN_KEY_VIOLATION_CODE);
}
