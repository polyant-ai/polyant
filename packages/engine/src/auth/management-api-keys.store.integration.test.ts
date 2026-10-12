// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for issuing, listing and revoking management API keys
 * against a real database.
 *
 * The unit tests mock the query builder, so they cannot see the two defects
 * that matter here: a listing whose RETURNING/SELECT carries the hash, and a
 * delete whose predicate forgot the organization. The token is also checked
 * end to end through `validateManagementApiKey`, the function `AuthGuard`
 * calls for `X-Polyant-Key`. Self-skips without a database; CI_REQUIRE_DB makes
 * an absent one a failure there.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryClient } from "../database/client.js";
import {
  createManagementApiKey,
  deleteManagementApiKey,
  listManagementApiKeys,
  validateManagementApiKey,
} from "./management-api-keys.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-mgmt-keys";

let orgA: string;
let orgB: string;

async function teardown(): Promise<void> {
  // Keys go with their organization (ON DELETE CASCADE).
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("management API keys store (integration)", () => {
  beforeAll(async () => {
    await teardown();
    [{ id: orgA }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER + "-a"}, 'A', false) RETURNING id`;
    [{ id: orgB }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER + "-b"}, 'B', false) RETURNING id`;
  });

  afterAll(async () => {
    await teardown();
  });

  it("issues a key whose token authenticates as its organization, until it is revoked", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const { key, token } = await createManagementApiKey({
      organizationId: orgA,
      name: "ci pipeline",
      permissions: ["agent:read", "org:write"],
      expiresAt,
    });

    const principal = await validateManagementApiKey(token);
    expect(principal?.principalType).toBe("service");
    expect(principal?.orgId).toBe(orgA);
    expect([...(principal?.permissions ?? [])].sort()).toEqual(["agent:read", "org:write"]);

    const listed = await listManagementApiKeys(orgA);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "lastUsedAt", "name", "permissions"],
    );
    expect(listed[0]).toMatchObject({ id: key.id, name: "ci pipeline" });
    expect(listed[0].expiresAt?.getTime()).toBe(expiresAt.getTime());

    // Another organization neither sees nor revokes it.
    expect(await listManagementApiKeys(orgB)).toEqual([]);
    expect(await deleteManagementApiKey(orgB, key.id)).toBe(false);
    expect(await validateManagementApiKey(token)).not.toBeNull();

    expect(await deleteManagementApiKey(orgA, key.id)).toBe(true);
    expect(await validateManagementApiKey(token)).toBeNull();
    expect(await listManagementApiKeys(orgA)).toEqual([]);
  });

  it("stores a digest, never the secret", async () => {
    const { key, token } = await createManagementApiKey({
      organizationId: orgA,
      name: "digest check",
      permissions: [],
      expiresAt: null,
    });
    const secret = token.slice(`pk_${key.id}_`.length);

    const [row] = await queryClient<{ key_hash: string }[]>`
      SELECT key_hash FROM management_api_keys WHERE id = ${key.id}`;
    expect(row.key_hash.startsWith("sha256:")).toBe(true);
    expect(row.key_hash).not.toContain(secret);
  });

  it("refuses a token once its expiry has passed", async () => {
    const { key, token } = await createManagementApiKey({
      organizationId: orgA,
      name: "short lived",
      permissions: ["agent:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await queryClient`
      UPDATE management_api_keys SET expires_at = now() - interval '1 minute' WHERE id = ${key.id}`;

    expect(await validateManagementApiKey(token)).toBeNull();
  });
});
