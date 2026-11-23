// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Agent secrets against a real Postgres: a saved value is stored encrypted and
 * read back decrypted, a second save replaces it, reads and deletes reach one
 * agent and one key only. Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import {
  deleteSecret,
  findInstanceByAuthApiKey,
  getAllSecrets,
  getAllSecretsById,
  getSecret,
  listSecretKeys,
  setSecret,
} from "./secrets.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-secrets-store";
const AGENT = asInstanceSlug(`${MARKER}-agent`);
const OTHER = asInstanceSlug(`${MARKER}-other`);
const MISSING = asInstanceSlug(`${MARKER}-missing`);
let agentId: InstanceUuid;
let otherId: InstanceUuid;

async function plantAgent(slug: string): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
    RETURNING id`;
  return asInstanceUuid(row.id);
}

async function storedValues(instanceId: InstanceUuid, key: string): Promise<string[]> {
  const rows = await queryClient<{ value: string }[]>`
    SELECT value FROM instance_secrets WHERE instance_id = ${instanceId} AND key = ${key}`;
  return rows.map((r) => r.value);
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("agent secrets (integration)", () => {
  beforeAll(async () => {
    await teardown();
    agentId = await plantAgent(AGENT);
    otherId = await plantAgent(OTHER);
  });

  afterAll(teardown);

  it("stores a value encrypted and reads it back decrypted", async () => {
    await setSecret(agentId, "openai_api_key", "sk-itest-plain");

    const [stored] = await storedValues(agentId, "openai_api_key");
    expect(stored).toBeDefined();
    expect(stored).not.toContain("sk-itest-plain");
    expect(await getSecret(AGENT, "openai_api_key")).toBe("sk-itest-plain");
  });

  it("a second save of the same key replaces the first in one row", async () => {
    await setSecret(agentId, "tavily_api_key", "tvly-1");
    await setSecret(agentId, "tavily_api_key", "tvly-2");

    expect(await storedValues(agentId, "tavily_api_key")).toHaveLength(1);
    expect(await getSecret(AGENT, "tavily_api_key")).toBe("tvly-2");
  });

  it("replacing an agent API key moves the lookup to the new key", async () => {
    await setSecret(agentId, "auth_api_key", "itest-key-old");
    await setSecret(agentId, "auth_api_key", "itest-key-new");

    expect(await findInstanceByAuthApiKey("itest-key-new")).toEqual({ slug: AGENT, instanceId: agentId });
    expect(await findInstanceByAuthApiKey("itest-key-old")).toBeNull();
  });

  it("reads nothing for an unknown agent or a key it does not have", async () => {
    expect(await getSecret(MISSING, "openai_api_key")).toBeUndefined();
    expect(await getSecret(AGENT, "github_token")).toBeUndefined();
    expect(await getAllSecrets(MISSING)).toEqual({});
    expect(await listSecretKeys(MISSING)).toEqual([]);
  });

  it("reads all secrets of one agent, by slug or by id, decrypted", async () => {
    await setSecret(otherId, "openai_api_key", "sk-other");

    const expected = { openai_api_key: "sk-itest-plain", tavily_api_key: "tvly-2", auth_api_key: "itest-key-new" };
    expect(await getAllSecrets(AGENT)).toEqual(expected);
    expect(await getAllSecretsById(agentId)).toEqual(expected);
    expect(await getAllSecretsById(otherId)).toEqual({ openai_api_key: "sk-other" });
  });

  it("lists every well-known key with whether it is set, and adds the agent's other keys", async () => {
    await setSecret(agentId, "custom_vendor_token", "v");

    const keys = await listSecretKeys(AGENT);

    expect(keys).toEqual(
      expect.arrayContaining([
        { key: "openai_api_key", configured: true },
        { key: "auth_api_key", configured: true },
        { key: "anthropic_api_key", configured: false },
        { key: "deepgram_api_key", configured: false },
        { key: "custom_vendor_token", configured: true },
      ]),
    );
    expect(keys.filter((k) => k.key === "openai_api_key")).toHaveLength(1);
    expect(keys.at(-1)).toEqual({ key: "custom_vendor_token", configured: true });
  });

  it("a delete removes that key of that agent only", async () => {
    await deleteSecret(agentId, "openai_api_key");

    expect(await getSecret(AGENT, "openai_api_key")).toBeUndefined();
    expect(await getSecret(AGENT, "tavily_api_key")).toBe("tvly-2");
    expect(await getSecret(OTHER, "openai_api_key")).toBe("sk-other");
  });
});
