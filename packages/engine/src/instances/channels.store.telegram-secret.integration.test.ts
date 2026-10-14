// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Telegram webhook secret, against a real Postgres: minted per channel by the
 * store, carried across saves, and minted once for a row stored before secrets
 * were per channel. Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { encrypt } from "../crypto/index.js";
import { workspaces } from "../organizations/organization.schema.js";
import { instances } from "./schema.js";
import { instanceChannels } from "./channels.schema.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import { ensureTelegramWebhookSecret, getChannelConfig, setChannelConfig } from "./channels.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = asInstanceSlug(`itest-telegram-secret-${Date.now()}`);
let instanceId: InstanceUuid;

const storedSecret = async () => (await getChannelConfig(SLUG, "telegram"))?.config.webhookSecret;

describe.skipIf(!DB_AVAILABLE)("Telegram webhook secret (integration)", () => {
  beforeAll(async () => {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1);
    const [row] = await db
      .insert(instances)
      .values({ slug: SLUG, name: "itest telegram secret", workspaceId: ws!.id })
      .returning({ id: instances.id });
    instanceId = asInstanceUuid(row!.id);
  });

  afterAll(async () => {
    if (instanceId) await db.delete(instances).where(eq(instances.id, instanceId));
  });

  it("mints a random secret on the first save, unrelated to the bot token", async () => {
    await setChannelConfig(instanceId, "telegram", { botToken: "123:ABC" }, true);

    const secret = await storedSecret();
    expect(typeof secret).toBe("string");
    expect(secret).not.toBe(createHash("sha256").update("123:ABC").digest("hex"));
  });

  it("keeps the secret across a save, and ignores one supplied in the config", async () => {
    const before = await storedSecret();

    await setChannelConfig(instanceId, "telegram", { botToken: "456:DEF", webhookSecret: "caller-chosen" }, true);

    expect(await storedSecret()).toBe(before);
  });

  it("mints and stores a secret once for a row saved without one", async () => {
    await db
      .update(instanceChannels)
      .set({ config: encrypt(JSON.stringify({ botToken: "123:ABC" })) })
      .where(and(eq(instanceChannels.instanceId, instanceId), eq(instanceChannels.channelType, "telegram")));

    const minted = await ensureTelegramWebhookSecret(SLUG);

    expect(await storedSecret()).toBe(minted);
    expect(await ensureTelegramWebhookSecret(SLUG)).toBe(minted);
  });
});
