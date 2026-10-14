// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Event source ownership against a real database.
 *
 * Every id-addressed operation on an event source or one of its definitions
 * takes the calling agent and must act only on that agent's rows: a source id
 * is not a secret, and its webhook token is a credential. The ownership check
 * is a WHERE clause, which a mocked query builder resolves to whatever rows it
 * was given. Self-skips without a database; CI_REQUIRE_DB makes an absent one a
 * failure there.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "../instances/identifiers.js";
import {
  createDefinition,
  createEventSource,
  deleteDefinition,
  deleteEventSource,
  findByWebhookToken,
  getEventSourceWebhookToken,
  listDefinitions,
  listEventSources,
  rotateWebhookToken,
  updateDefinition,
  updateEventSource,
} from "./webhook-sources.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-webhook-sources";
const SLUG_OWNER = `${MARKER}-owner`;
const SLUG_OTHER = `${MARKER}-other`;

let owner: InstanceUuid;
let other: InstanceUuid;

async function plantAgent(slug: string): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
    RETURNING id`;
  return asInstanceUuid(row.id);
}

async function teardown(): Promise<void> {
  // Sources and definitions go with their agent (ON DELETE CASCADE).
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

async function sourceOfOwner(): Promise<{ id: string; webhookToken: string }> {
  return createEventSource(owner, {
    name: "crm",
    sourceType: "generic",
    config: { apiSecret: "config-plaintext-marker" },
  });
}

const definition = { name: "deal won", matchingPrompt: "a deal is won", interpretationPrompt: "summarize" };

describe.skipIf(!DB_AVAILABLE)("webhook sources store (integration)", () => {
  beforeAll(async () => {
    await teardown();
    owner = await plantAgent(SLUG_OWNER);
    other = await plantAgent(SLUG_OTHER);
  });

  afterAll(teardown);

  it("lets another agent neither read, change, rotate nor delete a source by its id", async () => {
    const { id, webhookToken } = await sourceOfOwner();

    expect(await getEventSourceWebhookToken(id, other)).toBeNull();
    expect(await rotateWebhookToken(id, other)).toBeNull();
    expect(await updateEventSource(id, other, { name: "hijacked", enabled: false })).toBe(false);
    expect(await updateEventSource(id, other, { config: { apiSecret: "attacker" } })).toBe(false);
    expect(await deleteEventSource(id, other)).toBe(false);
    expect((await listEventSources(asInstanceSlug(SLUG_OTHER))).map((s) => s.id)).not.toContain(id);

    const [mine] = (await listEventSources(asInstanceSlug(SLUG_OWNER))).filter((s) => s.id === id);
    expect(mine).toMatchObject({ name: "crm", enabled: true, webhookToken, config: { apiSecret: "config-plaintext-marker" } });
    expect(await getEventSourceWebhookToken(id, owner)).toBe(webhookToken);
  });

  it("lets the owner rotate the token, after which the old one finds nothing", async () => {
    const { id, webhookToken } = await sourceOfOwner();

    const rotated = await rotateWebhookToken(id, owner);

    expect(rotated).not.toBeNull();
    expect(rotated).not.toBe(webhookToken);
    expect(await findByWebhookToken(webhookToken)).toBeNull();
    expect((await findByWebhookToken(rotated!))?.instanceId).toBe(owner);
  });

  it("lets the owner delete its source", async () => {
    const { id } = await sourceOfOwner();

    expect(await deleteEventSource(id, owner)).toBe(true);
    expect(await getEventSourceWebhookToken(id, owner)).toBeNull();
  });

  it("keeps another agent away from a source's definitions", async () => {
    const { id: sourceId } = await sourceOfOwner();
    const { id: defId } = await createDefinition(sourceId, owner, definition);

    await expect(createDefinition(sourceId, other, definition)).rejects.toThrow(/does not belong/);
    expect(await listDefinitions(sourceId, other)).toEqual([]);
    await updateDefinition(defId, sourceId, other, { name: "hijacked", enabled: false });
    await deleteDefinition(defId, sourceId, other);

    expect(await listDefinitions(sourceId, owner)).toEqual([
      expect.objectContaining({ id: defId, name: "deal won", enabled: true }),
    ]);
  });

  it("does not let an agent reach another source's definition through a source it owns", async () => {
    // The ownership check passes for the caller's own source; the definition id
    // belongs to a source of someone else. Only the definition's own
    // event_source_id predicate stands between them.
    const { id: victimSource } = await sourceOfOwner();
    const { id: victimDef } = await createDefinition(victimSource, owner, definition);
    const { id: attackerSource } = await createEventSource(other, { name: "mine", sourceType: "generic", config: {} });

    await updateDefinition(victimDef, attackerSource, other, { name: "hijacked" });
    await deleteDefinition(victimDef, attackerSource, other);

    expect(await listDefinitions(victimSource, owner)).toEqual([
      expect.objectContaining({ id: victimDef, name: "deal won" }),
    ]);
  });

  it("stores the source config encrypted", async () => {
    const { id } = await sourceOfOwner();

    const [row] = await queryClient<{ config: string }[]>`SELECT config FROM event_sources WHERE id = ${id}`;
    expect(row.config).not.toContain("config-plaintext-marker");
  });
});
