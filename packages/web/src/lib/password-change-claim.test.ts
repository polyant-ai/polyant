// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `mustChangePassword` claim follows the database on a session update, and
 * only the database. The errors caught: the claim staying set after the user
 * changed their password (they would be held on /password-change forever), and
 * the claim clearing when the database could not be asked (a failed read must
 * not release a user who still owes a new password).
 */

import { describe, expect, it } from "vitest";
import { refreshPasswordChangeClaim } from "./password-change-claim";

describe("refreshPasswordChangeClaim", () => {
  it("clears the claim once the database says the password was changed", async () => {
    const token = { id: "u1", mustChangePassword: true };
    await refreshPasswordChangeClaim(token, async () => false);
    expect(token.mustChangePassword).toBe(false);
  });

  it("keeps the claim while the database still owes a change", async () => {
    const token = { id: "u1", mustChangePassword: true };
    await refreshPasswordChangeClaim(token, async () => true);
    expect(token.mustChangePassword).toBe(true);
  });

  it("reads the flag of the user the token names", async () => {
    const asked: string[] = [];
    await refreshPasswordChangeClaim({ id: "u1", mustChangePassword: true }, async (id) => {
      asked.push(id);
      return false;
    });
    expect(asked).toEqual(["u1"]);
  });

  it("keeps the claim when the read fails or finds no user", async () => {
    const failed = { id: "u1", mustChangePassword: true };
    await refreshPasswordChangeClaim(failed, async () => {
      throw new Error("database down");
    });
    expect(failed.mustChangePassword).toBe(true);

    const missing = { id: "u1", mustChangePassword: true };
    await refreshPasswordChangeClaim(missing, async () => null);
    expect(missing.mustChangePassword).toBe(true);
  });
});
