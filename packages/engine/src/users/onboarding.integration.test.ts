// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-user onboarding record against a real database: a write lands on the
 * caller's row only, steps merge instead of overwriting, a NULL column reads as
 * "not seen", and migration 0093 starts the accounts that already exist as
 * dismissed so an upgrade does not throw a wizard at them.
 *
 * Self-skips without a migrated database.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { getOnboarding, patchOnboarding, insertUser } from "./users.store.js";
import { UsersService } from "./users.service.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

const MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "database", "migrations", "0093_user_onboarding.sql"),
  "utf8",
);

describe.skipIf(!DB_AVAILABLE)("user onboarding record", () => {
  const emails = ["onb-a@example.test", "onb-b@example.test"];
  const cleanup = async () => {
    await queryClient`DELETE FROM users WHERE email IN ${queryClient(emails)}`;
  };
  beforeEach(cleanup);
  afterEach(cleanup);

  async function plant(email: string): Promise<string> {
    const u = await insertUser({
      email,
      passwordHash: null,
      isPlatformAdmin: false,
      mustChangePassword: false,
    });
    return u.id;
  }

  it("reads a user created after the migration as new", async () => {
    const a = await plant(emails[0]);
    expect(await getOnboarding(a)).toEqual({
      wizard: "new",
      interfaceTour: "new",
      agentTour: "new",
      steps: {},
    });
  });

  it("writes the caller's row and leaves every other user's untouched", async () => {
    const a = await plant(emails[0]);
    const b = await plant(emails[1]);

    await patchOnboarding(a, { wizard: "skipped", steps: { provider: "skip" } });

    expect((await getOnboarding(a))?.wizard).toBe("skipped");
    expect((await getOnboarding(b))?.wizard).toBe("new");
    expect((await getOnboarding(b))?.steps).toEqual({});
  });

  it("merges steps across writes", async () => {
    const a = await plant(emails[0]);
    await patchOnboarding(a, { steps: { provider: "done" } });
    const next = await patchOnboarding(a, { steps: { agent: "skip" }, interfaceTour: "seen" });
    expect(next).toEqual({
      wizard: "new",
      interfaceTour: "seen",
      agentTour: "new",
      steps: { provider: "done", agent: "skip" },
    });
  });

  it("returns null for a user that does not exist", async () => {
    expect(await patchOnboarding("00000000-0000-0000-0000-000000000000", { wizard: "done" })).toBeNull();
  });

  it("the service refuses an invalid value before touching the database", async () => {
    const a = await plant(emails[0]);
    await expect(new UsersService().updateOwnOnboarding({ userId: a }, { wizard: "maybe" })).rejects.toThrow();
    expect((await getOnboarding(a))?.wizard).toBe("new");
  });

  it("migration 0093 backfills existing users as dismissed and leaves recorded choices", async () => {
    const a = await plant(emails[0]);
    const b = await plant(emails[1]);
    await patchOnboarding(b, { wizard: "skipped" });

    // The ALTER already ran with the migrations; replay only the backfill.
    const backfill = MIGRATION.split("\n").filter((l) => !l.startsWith("--")).join("\n").split(";")
      .map((s) => s.trim()).filter((s) => s.startsWith("UPDATE"));
    expect(backfill).toHaveLength(1);
    await queryClient.unsafe(backfill[0]);

    expect(await getOnboarding(a)).toMatchObject({ wizard: "dismissed", interfaceTour: "dismissed", agentTour: "dismissed" });
    expect((await getOnboarding(b))?.wizard).toBe("skipped");
  });
});
