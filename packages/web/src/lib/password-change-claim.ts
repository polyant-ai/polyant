// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Re-read the `mustChangePassword` claim from the database when the session is
 * refreshed with `useSession().update()`.
 *
 * The claim decides whether the panel holds the user on `/password-change`, so
 * it can only come from the server: at sign-in from the engine's credentials
 * check, afterwards from the `users.must_change_password` column. It used to be
 * copied from the client's update patch, so a user holding an admin-issued
 * temporary password cleared it with one POST to `/api/auth/session`.
 *
 * Fails closed: when the read fails, or finds no user, the claim keeps the value
 * it had. A user held on the page stays held until the database says otherwise.
 */
export async function refreshPasswordChangeClaim(
  token: { id?: unknown; mustChangePassword?: unknown },
  readFlag: (userId: string) => Promise<boolean | null>,
): Promise<void> {
  if (typeof token.id !== "string") return;
  try {
    const flag = await readFlag(token.id);
    if (typeof flag === "boolean") token.mustChangePassword = flag;
  } catch (err) {
    console.error("[auth] could not re-read must_change_password; keeping the claim", err);
  }
}
