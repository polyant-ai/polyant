// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stored channel config that cannot be read (empty, not ciphertext, sealed
 * with another key, not JSON) reads as an empty config, alone or next to a
 * readable one, instead of failing the read. Against a real Postgres; self-skips
 * when no migrated database is reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { encrypt } from "../crypto/index.js";
import { asInstanceSlug } from "./identifiers.js";
import { getChannelConfig, listChannelConfigs } from "./channels.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-channels-decrypt";
const SLUG = asInstanceSlug(`${MARKER}-agent`);
let agentId: string;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

async function storeRaw(channelType: string, config: string, enabled = true): Promise<void> {
  await queryClient`
    INSERT INTO instance_channels (instance_id, channel_type, enabled, config)
    VALUES (${agentId}, ${channelType}, ${enabled}, ${config})`;
}

describe.skipIf(!DB_AVAILABLE)("unreadable channel configs (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const [row] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${SLUG}, 'd', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
      RETURNING id`;
    agentId = row!.id;
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM instance_channels WHERE instance_id = ${agentId}`;
  });

  afterAll(teardown);

  it.each([
    ["empty", ""],
    ["not ciphertext", "nocolonshere"],
    ["sealed with another key or corrupted", "corrupted:garbage:data"],
    ["ciphertext of something that is not JSON", encrypt("this is not json")],
  ])("reads a %s config as {}, keeping the channel and its flag", async (_case, raw) => {
    await storeRaw("whatsapp", raw, false);

    expect(await getChannelConfig(SLUG, "whatsapp")).toEqual({ channelType: "whatsapp", enabled: false, config: {} });
  });

  it("lists a readable config next to an unreadable one", async () => {
    await storeRaw("telegram", encrypt(JSON.stringify({ botToken: "123:ABC" })));
    await storeRaw("slack", "bad:corrupted", false);

    const byType = Object.fromEntries((await listChannelConfigs(SLUG)).map((c) => [c.channelType, c.config]));

    expect(byType).toEqual({ telegram: { botToken: "123:ABC" }, slack: {} });
  });
});
