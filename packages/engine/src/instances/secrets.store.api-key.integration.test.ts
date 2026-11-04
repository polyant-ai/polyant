// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Finding the agent an API key belongs to, against a real database.
 *
 * The lookup runs on every request to a route that accepts an agent key, with a
 * token anyone can send. Its cost must not grow with the number of agents, and
 * a wrong token must cost no more than a right one: it decrypts no stored key
 * but the one it matched. Self-skips without a database; CI_REQUIRE_DB makes
 * an absent one a failure there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const decrypts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../crypto/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../crypto/index.js")>();
  return {
    ...actual,
    decrypt: (value: string) => {
      decrypts.count++;
      return actual.decrypt(value);
    },
  };
});

import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { encrypt, lookupDigest } from "../crypto/index.js";
import { asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import { SECRET_KEYS, deleteSecret, findInstanceByAuthApiKey, setSecret } from "./secrets.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-agent-api-key";
const AGENTS = 20;

const agents: { slug: string; id: InstanceUuid }[] = [];

async function plantAgent(slug: string, status = "active"): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, status, workspace_id)
    VALUES (${slug}, ${slug}, ${status}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
    RETURNING id`;
  return asInstanceUuid(row.id);
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("agent API key lookup (integration)", () => {
  beforeAll(async () => {
    await teardown();
    for (let i = 0; i < AGENTS; i++) {
      const slug = `${MARKER}-${i}`;
      const id = await plantAgent(slug);
      agents.push({ slug, id });
      await setSecret(id, SECRET_KEYS.AUTH_API_KEY, `key-of-agent-${i}`);
    }
  });

  beforeEach(() => {
    decrypts.count = 0;
  });

  afterAll(teardown);

  it("finds the agent a key belongs to", async () => {
    expect(await findInstanceByAuthApiKey("key-of-agent-7")).toEqual({ slug: agents[7].slug, instanceId: agents[7].id });
  });

  it("decrypts no stored key for a wrong token, however many agents have one", async () => {
    expect(await findInstanceByAuthApiKey("not-a-key")).toBeNull();
    expect(decrypts.count).toBe(0);
  });

  it("decrypts at most the matched key for a right token", async () => {
    await findInstanceByAuthApiKey("key-of-agent-3");
    expect(decrypts.count).toBeLessThanOrEqual(1);
  });

  it("refuses the key of an agent that is not active", async () => {
    const id = await plantAgent(`${MARKER}-paused`, "paused");
    await setSecret(id, SECRET_KEYS.AUTH_API_KEY, "key-of-paused");
    expect(await findInstanceByAuthApiKey("key-of-paused")).toBeNull();
  });

  it("stops accepting a key once it is replaced or deleted", async () => {
    const id = await plantAgent(`${MARKER}-rotated`);
    await setSecret(id, SECRET_KEYS.AUTH_API_KEY, "old-key");
    await setSecret(id, SECRET_KEYS.AUTH_API_KEY, "new-key");
    expect(await findInstanceByAuthApiKey("old-key")).toBeNull();
    expect((await findInstanceByAuthApiKey("new-key"))?.instanceId).toBe(id);
    await deleteSecret(id, SECRET_KEYS.AUTH_API_KEY);
    expect(await findInstanceByAuthApiKey("new-key")).toBeNull();
  });

  it("refuses a key two agents share: it names neither", async () => {
    const a = await plantAgent(`${MARKER}-twin-a`);
    const b = await plantAgent(`${MARKER}-twin-b`);
    await setSecret(a, SECRET_KEYS.AUTH_API_KEY, "shared-key");
    await setSecret(b, SECRET_KEYS.AUTH_API_KEY, "shared-key");
    expect(await findInstanceByAuthApiKey("shared-key")).toBeNull();
  });

  it("stops accepting a key that an older release replaced by rewriting only its value", async () => {
    const id = await plantAgent(`${MARKER}-rotated-by-older`);
    await setSecret(id, SECRET_KEYS.AUTH_API_KEY, "revoked-key");
    // An older release rotates the key during a rolling deploy or after a rollback:
    // it rewrites the encrypted value and knows nothing of the digest column.
    await queryClient`
      UPDATE instance_secrets SET value = ${encrypt("replacement-key")}, updated_at = now()
      WHERE instance_id = ${id} AND key = ${SECRET_KEYS.AUTH_API_KEY}`;
    expect(await findInstanceByAuthApiKey("revoked-key")).toBeNull();
    expect((await findInstanceByAuthApiKey("replacement-key"))?.instanceId).toBe(id);
  });

  it("refuses a token whose digest matches but whose stored key differs", async () => {
    const id = await plantAgent(`${MARKER}-stale-digest`);
    await setSecret(id, SECRET_KEYS.AUTH_API_KEY, "first-key");
    // A digest that no longer describes the stored value, however it came to be.
    await queryClient`
      UPDATE instance_secrets SET value = ${encrypt("stored-key")}, lookup_digest = ${lookupDigest("other-key")}
      WHERE instance_id = ${id} AND key = ${SECRET_KEYS.AUTH_API_KEY}`;
    expect(await findInstanceByAuthApiKey("other-key")).toBeNull();
    expect((await findInstanceByAuthApiKey("stored-key"))?.instanceId).toBe(id);
  });

  it("finds a key stored before the lookup digest existed, and needs no scan for it afterwards", async () => {
    const id = await plantAgent(`${MARKER}-legacy`);
    // A row as an older release wrote it: the encrypted value and nothing else.
    await queryClient`
      INSERT INTO instance_secrets (instance_id, key, value) VALUES (${id}, ${SECRET_KEYS.AUTH_API_KEY}, ${encrypt("legacy-key")})`;
    expect((await findInstanceByAuthApiKey("legacy-key"))?.instanceId).toBe(id);
    decrypts.count = 0;
    expect(await findInstanceByAuthApiKey("still-not-a-key")).toBeNull();
    expect(decrypts.count).toBe(0);
  });
});
