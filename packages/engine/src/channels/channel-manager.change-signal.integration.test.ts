// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two engine processes against one real Postgres: a channel saved through one
 * reaches the other's adapter registry. Self-skips when no migrated database
 * is reachable.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { config } from "../config.js";
import { db } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { workspaces } from "../organizations/organization.schema.js";
import { instances } from "../instances/schema.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "../instances/identifiers.js";
import { isWebChannelEnabled, setChannelConfig } from "../instances/channels.store.js";
import { instanceChannels } from "../instances/channels.schema.js";
import { ChannelManager } from "./channel-manager.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = asInstanceSlug(`itest-channel-signal-${Date.now()}`);

/** A process of its own: its own manager and its own Postgres connection. */
function engineProcess(): { manager: ChannelManager; sql: postgres.Sql } {
  const manager = new ChannelManager();
  manager.setMessageHandler(async () => ({ text: "" }));
  return { manager, sql: postgres(config.postgres.databaseUrl, { max: 2 }) };
}

describe.skipIf(!DB_AVAILABLE)("channel changes across processes (integration)", () => {
  let instanceId: InstanceUuid;
  const saving = engineProcess();
  const other = engineProcess();

  beforeAll(async () => {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.isDefault, true)).limit(1);
    const [row] = await db
      .insert(instances)
      .values({ slug: SLUG, name: "itest channel signal", workspaceId: ws!.id })
      .returning({ id: instances.id });
    instanceId = asInstanceUuid(row!.id);
    await saving.manager.listenForChanges(saving.sql);
    await other.manager.listenForChanges(other.sql);
  });

  afterAll(async () => {
    await saving.manager.shutdownAll();
    await other.manager.shutdownAll();
    await Promise.all([saving.sql.end(), other.sql.end()]);
    if (instanceId) await db.delete(instances).where(eq(instances.id, instanceId));
  });

  it("starts the channel on the other process when it is enabled through one", async () => {
    await setChannelConfig(instanceId, "agent", {}, true);
    await saving.manager.startChannel(SLUG, "agent", {});
    await saving.manager.announceChange(SLUG, "agent");

    await vi.waitFor(() => expect(other.manager.getAdapter(SLUG, "agent")).toBeDefined(), { timeout: 5_000 });
  });

  it("stops it there when it is disabled through one", async () => {
    await setChannelConfig(instanceId, "agent", {}, false);
    await saving.manager.stopChannel(SLUG, "agent", { deregister: true });
    await saving.manager.announceChange(SLUG, "agent");

    await vi.waitFor(() => expect(other.manager.getAdapter(SLUG, "agent")).toBeUndefined(), { timeout: 5_000 });
  });

  it("closes the agent's public endpoints there as soon as Web is switched off through one", async () => {
    await setChannelConfig(instanceId, "web", {}, true);
    expect(await isWebChannelEnabled(instanceId)).toBe(true);
    // The other process saves the switch: this one only receives the signal.
    await db
      .update(instanceChannels)
      .set({ enabled: false })
      .where(and(eq(instanceChannels.instanceId, instanceId), eq(instanceChannels.channelType, "web")));
    await saving.manager.announceChange(SLUG, "web");

    await vi.waitFor(async () => expect(await isWebChannelEnabled(instanceId)).toBe(false), { timeout: 5_000 });
  });

  it("stops every channel there when the agent is deleted", async () => {
    await setChannelConfig(instanceId, "agent", {}, true);
    await other.manager.startChannel(SLUG, "agent", {});
    await db.delete(instances).where(eq(instances.id, instanceId));
    await saving.manager.announceChange(SLUG);

    await vi.waitFor(() => expect(other.manager.getAdapter(SLUG, "agent")).toBeUndefined(), { timeout: 5_000 });
  });

  it("ignores its own signal", async () => {
    const own = engineProcess();
    await own.manager.listenForChanges(own.sql);
    await own.manager.startChannel(SLUG, "agent", {});
    await own.manager.announceChange(SLUG, "agent");
    // The row is gone: a reload would have stopped the adapter.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(own.manager.getAdapter(SLUG, "agent")).toBeDefined();
    await own.manager.shutdownAll();
    await own.sql.end();
  });
});
