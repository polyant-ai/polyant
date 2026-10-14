// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-conversation secret vault against a real database.
 *
 * These rows hold OAuth tokens. What protects them is the WHERE clause: a read
 * or delete that loses its conversation predicate hands one person's token to
 * another conversation, or revokes it for everyone. A mocked query builder
 * resolves any chain to the configured rows, so only a real database can tell
 * the predicates apart. Self-skips without one; CI_REQUIRE_DB makes an absent
 * database a failure there.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import {
  deletePrincipalSecret,
  getPrincipalSecret,
  listPrincipalSecretKeys,
  setPrincipalSecret,
} from "./principal-secrets.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-principal-secrets";
const ALICE = `${MARKER}-alice`;
const BOB = `${MARKER}-bob`;
const KEY = "github_oauth_token";

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM principal_secrets WHERE scope_key LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("principal secrets store (integration)", () => {
  beforeEach(teardown);
  afterAll(teardown);

  it("gives each conversation its own token under the same key", async () => {
    await setPrincipalSecret(ALICE, "agent", KEY, "gho_alice");
    await setPrincipalSecret(BOB, "agent", KEY, "gho_bob");

    expect((await getPrincipalSecret(ALICE, KEY))?.value).toBe("gho_alice");
    expect((await getPrincipalSecret(BOB, KEY))?.value).toBe("gho_bob");
    expect(await getPrincipalSecret(`${MARKER}-carol`, KEY)).toBeUndefined();
  });

  it("revokes a token for one conversation and one key only", async () => {
    await setPrincipalSecret(ALICE, "agent", KEY, "gho_alice");
    await setPrincipalSecret(ALICE, "agent", "google_oauth_token", "ya29_alice");
    await setPrincipalSecret(BOB, "agent", KEY, "gho_bob");

    await deletePrincipalSecret(ALICE, KEY);

    expect(await getPrincipalSecret(ALICE, KEY)).toBeUndefined();
    expect((await getPrincipalSecret(ALICE, "google_oauth_token"))?.value).toBe("ya29_alice");
    expect((await getPrincipalSecret(BOB, KEY))?.value).toBe("gho_bob");
  });

  it("lists a conversation's keys and expiries, never a value or another conversation's key", async () => {
    const expiresAt = new Date("2031-01-01T00:00:00.000Z");
    await setPrincipalSecret(ALICE, "agent", KEY, "gho_alice", expiresAt);
    await setPrincipalSecret(BOB, "agent", "google_oauth_token", "ya29_bob");

    expect(await listPrincipalSecretKeys(ALICE)).toEqual([{ key: KEY, expiresAt }]);
  });

  it("replaces a token and its expiry on a second write", async () => {
    await setPrincipalSecret(ALICE, "agent", KEY, "gho_old", new Date("2030-01-01T00:00:00.000Z"));
    await setPrincipalSecret(ALICE, "agent", KEY, "gho_new", null);

    expect(await getPrincipalSecret(ALICE, KEY)).toEqual({ value: "gho_new", expiresAt: null });
  });

  it("stores the token encrypted", async () => {
    await setPrincipalSecret(ALICE, "agent", KEY, "gho_plaintext_marker");

    const [row] = await queryClient<{ value: string }[]>`
      SELECT value FROM principal_secrets WHERE scope_key = ${ALICE} AND key = ${KEY}`;
    expect(row.value).not.toContain("gho_plaintext_marker");
  });
});
