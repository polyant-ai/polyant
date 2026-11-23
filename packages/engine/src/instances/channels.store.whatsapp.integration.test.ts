// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WhatsApp channel saves against a real Postgres: what a save stores per
 * credential mode, and the webhook secret the store owns in apiKey mode
 * (minted, carried across saves, dropped on a switch to authToken, rotated on
 * request), including a save that races another writer of the same row.
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { decrypt, encrypt } from "../crypto/index.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import { getChannelConfig, setChannelConfig } from "./channels.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-channels-wa";
const SLUG = asInstanceSlug(`${MARKER}-agent`);
let agent: InstanceUuid;

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const API_KEY_SID = "SK00000000000000000000000000000002";
const NUMBER = "+14155238886";
const API_KEY = { authMode: "apiKey", accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: "sec", whatsappNumber: NUMBER };
const AUTH_TOKEN = { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: NUMBER };

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

/** The decrypted config stored in the row, as saved. */
async function storedConfig(): Promise<Record<string, unknown> | undefined> {
  const [row] = await queryClient<{ config: string }[]>`
    SELECT config FROM instance_channels WHERE instance_id = ${agent} AND channel_type = 'whatsapp'`;
  return row ? (JSON.parse(decrypt(row.config)) as Record<string, unknown>) : undefined;
}

describe.skipIf(!DB_AVAILABLE)("WhatsApp channel config (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const [row] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${SLUG}, 'wa', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
      RETURNING id`;
    agent = asInstanceUuid(row!.id);
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM instance_channels WHERE instance_id = ${agent}`;
  });

  afterAll(teardown);

  it("stores the parsed config: authMode defaulted, credentials trimmed", async () => {
    await setChannelConfig(agent, "whatsapp", { accountSid: ` ${ACCOUNT_SID} `, authToken: " tok\n", whatsappNumber: NUMBER }, true);

    expect(await storedConfig()).toEqual(AUTH_TOKEN);
    expect(await getChannelConfig(SLUG, "whatsapp")).toEqual({ channelType: "whatsapp", enabled: true, config: AUTH_TOKEN });
  });

  it("refuses an invalid config without writing it", async () => {
    await expect(setChannelConfig(agent, "whatsapp", { authToken: "tok", whatsappNumber: NUMBER }, true)).rejects.toThrow(ZodError);
    await expect(
      setChannelConfig(agent, "whatsapp", { accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: "nope" }, true),
    ).rejects.toThrow(ZodError);

    expect(await storedConfig()).toBeUndefined();
  });

  it("drops the other mode's credentials and mints its own secret, ignoring one from the caller", async () => {
    const result = await setChannelConfig(
      agent, "whatsapp", { ...API_KEY, authToken: "stale", webhookSecret: "caller-chosen" }, true,
    );

    expect(result.mintedWebhookSecret).toBe(true);
    const stored = await storedConfig();
    expect(stored).not.toHaveProperty("authToken");
    expect(stored!.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.webhookSecret).not.toBe("caller-chosen");
    expect(result.config.webhookSecret).toBe(stored!.webhookSecret);
  });

  it("mints in apiKey mode, keeps the secret across saves, drops it in authToken mode, and mints a new one on the way back", async () => {
    const first = await setChannelConfig(agent, "whatsapp", API_KEY, true);
    const secret = first.config.webhookSecret;

    const second = await setChannelConfig(agent, "whatsapp", { ...API_KEY, whatsappNumber: "+19998887777" }, true);
    expect(second.mintedWebhookSecret).toBe(false);
    expect(await storedConfig()).toMatchObject({ webhookSecret: secret, whatsappNumber: "+19998887777" });

    const third = await setChannelConfig(agent, "whatsapp", AUTH_TOKEN, true);
    expect(third.mintedWebhookSecret).toBe(false);
    expect(await storedConfig()).not.toHaveProperty("webhookSecret");

    const fourth = await setChannelConfig(agent, "whatsapp", API_KEY, true);
    expect(fourth.mintedWebhookSecret).toBe(true);
    expect((await storedConfig())!.webhookSecret).not.toBe(secret);
  });

  it("an authToken save mints no secret", async () => {
    const result = await setChannelConfig(agent, "whatsapp", AUTH_TOKEN, true);

    expect(result.mintedWebhookSecret).toBe(false);
    expect(await storedConfig()).not.toHaveProperty("webhookSecret");
  });

  it("a rotation stores exactly the value asked for and reports no mint", async () => {
    await setChannelConfig(agent, "whatsapp", API_KEY, true);

    const result = await setChannelConfig(agent, "whatsapp", API_KEY, true, { rotateWebhookSecretTo: "rotated-value" });

    expect(result.mintedWebhookSecret).toBe(false);
    expect((await storedConfig())!.webhookSecret).toBe("rotated-value");
  });

  it("a save that waits on another writer of the row carries the secret that writer committed", async () => {
    await setChannelConfig(agent, "whatsapp", API_KEY, true);
    const rotated = encrypt(JSON.stringify({ ...API_KEY, webhookSecret: "committed-by-the-other-writer" }));

    // Another writer holds the row (a rotation in flight) while this save runs.
    const other = await queryClient.reserve();
    try {
      await other`BEGIN`;
      await other`SELECT 1 FROM instance_channels WHERE instance_id = ${agent} AND channel_type = 'whatsapp' FOR UPDATE`;
      const save = setChannelConfig(agent, "whatsapp", { ...API_KEY, whatsappNumber: "+19998887777" }, true);

      // Wait until the save is blocked on the row, whichever of its statements that is.
      for (;;) {
        const [{ waiting }] = await queryClient<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%instance_channels%'`;
        if (waiting > 0) break;
      }
      await other`UPDATE instance_channels SET config = ${rotated} WHERE instance_id = ${agent} AND channel_type = 'whatsapp'`;
      await other`COMMIT`;
      await save;
    } finally {
      other.release();
    }

    expect(await storedConfig()).toMatchObject({ webhookSecret: "committed-by-the-other-writer", whatsappNumber: "+19998887777" });
  });
});
