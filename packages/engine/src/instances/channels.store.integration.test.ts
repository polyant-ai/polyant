// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel configs against a real Postgres: what a save stores, what each read
 * returns, and which rows a delete reaches. Self-skips when no migrated database
 * is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { workspaces } from "../organizations/organization.schema.js";
import { instances } from "./schema.js";
import { instanceChannels } from "./channels.schema.js";
import { asInstanceSlug, asInstanceUuid, type InstanceSlug, type InstanceUuid } from "./identifiers.js";
import {
  deleteChannelConfig,
  getChannelConfig,
  listChannelConfigs,
  listEnabledChannelConfigs,
  setChannelConfig,
} from "./channels.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const RUN = Date.now();
const SLUG = asInstanceSlug(`itest-channels-${RUN}`);
const OTHER_SLUG = asInstanceSlug(`itest-channels-other-${RUN}`);
const UNKNOWN_SLUG = asInstanceSlug(`itest-channels-missing-${RUN}`);
const SLACK = { botToken: "xoxb-itest", signingSecret: "itest-signing-secret" };
let agent: InstanceUuid;
let otherAgent: InstanceUuid;

async function createAgent(slug: InstanceSlug): Promise<InstanceUuid> {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1);
  const [row] = await db
    .insert(instances)
    .values({ slug, name: `itest ${slug}`, workspaceId: ws!.id })
    .returning({ id: instances.id });
  return asInstanceUuid(row!.id);
}

async function storedRows(instanceId: InstanceUuid) {
  return db
    .select({ channelType: instanceChannels.channelType, config: instanceChannels.config })
    .from(instanceChannels)
    .where(eq(instanceChannels.instanceId, instanceId));
}

describe.skipIf(!DB_AVAILABLE)("channel configs (integration)", () => {
  beforeAll(async () => {
    agent = await createAgent(SLUG);
    otherAgent = await createAgent(OTHER_SLUG);
  });

  afterAll(async () => {
    for (const id of [agent, otherAgent]) if (id) await db.delete(instances).where(eq(instances.id, id));
  });

  it("stores a saved config encrypted and reads it back decrypted", async () => {
    const result = await setChannelConfig(agent, "slack", SLACK, true);

    expect(result.config).toEqual(SLACK);
    expect(result.mintedWebhookSecret).toBe(false);
    const [row] = await storedRows(agent);
    expect(row!.config).not.toContain(SLACK.signingSecret);
    expect(await getChannelConfig(SLUG, "slack")).toEqual({ channelType: "slack", enabled: true, config: SLACK });
  });

  it("a second save replaces the first one", async () => {
    const changed = { ...SLACK, botToken: "xoxb-itest-2" };

    await setChannelConfig(agent, "slack", changed, false);

    expect((await storedRows(agent)).filter((r) => r.channelType === "slack")).toHaveLength(1);
    expect(await getChannelConfig(SLUG, "slack")).toEqual({ channelType: "slack", enabled: false, config: changed });
  });

  it("refuses an invalid config without writing it", async () => {
    await expect(setChannelConfig(otherAgent, "slack", { botToken: "xoxb" }, true)).rejects.toThrow(ZodError);

    expect(await storedRows(otherAgent)).toEqual([]);
  });

  it("reads nothing for an unknown agent or a channel it does not have", async () => {
    expect(await getChannelConfig(UNKNOWN_SLUG, "slack")).toBeNull();
    expect(await getChannelConfig(SLUG, "whatsapp")).toBeNull();
    expect(await listChannelConfigs(UNKNOWN_SLUG)).toEqual([]);
    expect(await listEnabledChannelConfigs(UNKNOWN_SLUG)).toEqual([]);
  });

  it("lists every channel of the agent, and only the enabled ones when asked", async () => {
    await setChannelConfig(agent, "slack", SLACK, false);
    await setChannelConfig(agent, "telegram", { botToken: "123:ABC" }, true);
    await setChannelConfig(otherAgent, "slack", SLACK, true);

    const all = await listChannelConfigs(SLUG);
    expect(all.map((c) => [c.channelType, c.enabled]).sort()).toEqual([["slack", false], ["telegram", true]]);
    expect(all.find((c) => c.channelType === "slack")?.config).toEqual(SLACK);

    const enabled = await listEnabledChannelConfigs(SLUG);
    expect(enabled.map((c) => c.channelType)).toEqual(["telegram"]);
    expect(enabled[0]!.config.botToken).toBe("123:ABC");
  });

  it("a delete removes that channel of that agent only", async () => {
    await setChannelConfig(agent, "slack", SLACK, true);
    await setChannelConfig(otherAgent, "slack", SLACK, true);

    await deleteChannelConfig(agent, "slack");

    expect((await storedRows(agent)).map((r) => r.channelType)).toEqual(["telegram"]);
    const otherSlack = await db
      .select({ id: instanceChannels.id })
      .from(instanceChannels)
      .where(and(eq(instanceChannels.instanceId, otherAgent), eq(instanceChannels.channelType, "slack")));
    expect(otherSlack).toHaveLength(1);
  });
});
