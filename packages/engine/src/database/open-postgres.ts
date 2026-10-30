// SPDX-License-Identifier: AGPL-3.0-or-later

import postgres from "postgres";

/**
 * `postgres()`, without ever printing the connection string.
 *
 * The driver parses the string as soon as it is called, which is at import time
 * here, before boot has an error handler. On a string it cannot read it throws a
 * TypeError whose `input` property is the whole string, password included, and
 * Node prints that property for an uncaught error. Two common ways to get there:
 * a POSTGRES_PORT that is not a number (a Kubernetes Service named `postgres`
 * sets it to `tcp://…` in every pod), or a `#` or `/` left unencoded in the
 * password of a DATABASE_URL. The error is replaced by one that names the
 * variables, not their value, and keeps no reference to the original.
 */
export function openPostgres(url: string, options: postgres.Options<Record<string, never>>): postgres.Sql {
  try {
    return postgres(url, options);
  } catch (err) {
    // eslint-disable-next-line preserve-caught-error -- the caught error holds the password, so it is dropped on purpose
    throw new Error(unreadableConnectionString(err));
  }
}

/** The replacement message: the original error's name and code, never its message or input. */
function unreadableConnectionString(err: unknown): string {
  const { name, code } = (err ?? {}) as { name?: unknown; code?: unknown };
  const what = [name, code].filter((part) => typeof part === "string").join(" ");
  return (
    "DATABASE_URL, or the POSTGRES_* variables, do not form a connection string the database driver can read" +
    (what ? ` (${what})` : "") +
    ": check POSTGRES_HOST and POSTGRES_PORT (a number), or, in DATABASE_URL, percent-encode special characters" +
    " in the user and password. The value is not shown because it holds the password."
  );
}
