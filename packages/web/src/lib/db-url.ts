// SPDX-License-Identifier: AGPL-3.0-or-later

import postgres from "postgres";

/**
 * The panel's Postgres connection string, assembled in ONE place.
 *
 * Two forms are both first-class and neither can be dropped: `DATABASE_URL` is
 * what a managed provider hands you and what local development copies, while the
 * individual `POSTGRES_*` are what a deployment gets — `polyant-deployments`
 * wires each one from a separate field of the Aurora secret, and CDK cannot read
 * a secret's value at synth time to assemble a URL.
 *
 * This is a second copy of the engine's `buildDatabaseUrl` on purpose: the panel
 * is an independently deployable package that imports nothing from the engine, so
 * the rule cannot be shared — but it is now written once per package and pinned
 * by a test, instead of inlined at its single call site with a different scheme.
 *
 * The credentials are percent-encoded. Interpolating them raw made a password
 * containing `@`, `/` or `:` produce a URL that parses as a different host.
 */
type DatabaseEnv = Record<string, string | undefined>;

export function databaseUrlFromEnv(env: DatabaseEnv = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const user = encodeURIComponent(env.POSTGRES_USER ?? "polyant");
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? "");
  const host = env.POSTGRES_HOST ?? "localhost";
  const port = env.POSTGRES_PORT ?? "5432";
  const database = env.POSTGRES_DB ?? "polyant";

  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

/** Whether to open the connection with TLS. Only the literal "true" enables it. */
export function databaseSslFromEnv(env: DatabaseEnv = process.env): { rejectUnauthorized: boolean } | false {
  return env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : false;
}

/**
 * `postgres()` for the panel, without ever printing the connection string: the
 * same guard as the engine's `openPostgres`. On a string it cannot read (for
 * example a POSTGRES_PORT that is not a number, or an unencoded `#` in a
 * DATABASE_URL password) the driver throws a TypeError whose `input` property is
 * the whole string, password included, and the server log prints it.
 */
export function openDatabase(env: DatabaseEnv = process.env): postgres.Sql {
  try {
    return postgres(databaseUrlFromEnv(env), { ssl: databaseSslFromEnv(env) });
  } catch (err) {
    // Not `{ cause: err }`: the caught error holds the password.
    const { name, code } = (err ?? {}) as { name?: unknown; code?: unknown };
    const what = [name, code].filter((part) => typeof part === "string").join(" ");
    throw new Error(
      "DATABASE_URL, or the POSTGRES_* variables, do not form a connection string the database driver can read" +
        (what ? ` (${what})` : "") +
        ": check POSTGRES_HOST and POSTGRES_PORT (a number), or, in DATABASE_URL, percent-encode special characters" +
        " in the user and password. The value is not shown because it holds the password.",
    );
  }
}
