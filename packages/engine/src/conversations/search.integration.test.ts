// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Conversation search finds the organization's conversations whose messages,
 * conversation id or contact match, counts them, and pages through them
 * without repeating or skipping one — for a term few messages carry and for
 * one so frequent that the search takes its other path.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { orgScope } from "../authz/scope-filter.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { conversationStore } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const MARKER = `itest-csearch-${RUN}`;
/** Carried by a handful of messages: the deployment-wide probe sees every one of them. */
const RARE = `zqrare${RUN}`;
/** Carried by more messages than the probe reads, in this organization and the other one. */
const FREQUENT = `zqfreq${RUN}`;
const FREQUENT_MESSAGES = 6_000;

interface Org {
  orgId: string;
  agents: string[];
}

async function seedOrg(label: string, agents: number): Promise<Org> {
  const slug = `${MARKER}-${label}`;
  const [{ id: orgId }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${slug}, ${slug}, false) RETURNING id`;
  const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${slug}, ${slug}, false) RETURNING id`;
  const slugs = Array.from({ length: agents }, (_, a) => `${slug}-a${a}`);
  for (const agent of slugs) {
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${agent}, ${agent}, ${workspaceId})`;
  }
  return { orgId, agents: slugs };
}

/** `count` conversations per agent, all updated at the same instant, each with one plain message. */
async function seedConversations(org: Org, count: number): Promise<void> {
  await queryClient`
    INSERT INTO conversations (conversation_id, instance_id, user_identifier, updated_at)
    SELECT a.slug || '-c' || n, a.slug, 'contact-' || n || '@example.test', '2026-03-01T10:00:00Z'::timestamptz
    FROM unnest(${org.agents}::text[]) a(slug), generate_series(0, ${count - 1}) n`;
  await queryClient`
    INSERT INTO conversation_messages (conversation_id, role, content)
    SELECT conversation_id, 'user', 'nothing to see here' FROM conversations WHERE instance_id = ANY(${org.agents}::text[])`;
}

/** Messages carrying `term`, spread round-robin over the given conversations. */
async function plant(term: string, conversationIds: string[], messages: number): Promise<void> {
  await queryClient`
    INSERT INTO conversation_messages (conversation_id, role, content)
    SELECT (${conversationIds}::text[])[1 + (g % ${conversationIds.length})], 'user', 'about the ' || ${term} || ' again ' || g
    FROM generate_series(0, ${messages - 1}) g`;
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversation_messages WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

/** The organization's conversations with a message carrying `term`, derived without the store. */
async function withMessage(org: Org, term: string): Promise<string[]> {
  const rows = await queryClient<{ conversation_id: string }[]>`
    SELECT DISTINCT c.conversation_id FROM conversations c
    JOIN conversation_messages cm ON cm.conversation_id = c.conversation_id
    WHERE c.instance_id = ANY(${org.agents}::text[]) AND cm.content LIKE ${`%${term}%`}`;
  return rows.map((r) => r.conversation_id).sort();
}

async function searchAll(org: Org, term: string, pageSize: number) {
  const seen: string[] = [];
  let total = -1;
  for (let offset = 0; total < 0 || offset < total; offset += pageSize) {
    const page = await conversationStore.searchConversations(term, { scope: orgScope(org.orgId), limit: pageSize, offset });
    total = page.total;
    seen.push(...page.conversations.map((c) => c.conversationId));
    if (page.conversations.length === 0) break;
  }
  return { seen, total };
}

describe.skipIf(!DB_AVAILABLE)("conversationStore.searchConversations (integration)", () => {
  let org: Org;
  let other: Org;

  beforeAll(async () => {
    await teardown();
    org = await seedOrg("org", 2);
    other = await seedOrg("other", 1);
    await seedConversations(org, 40);
    await seedConversations(other, 10);
    const a0 = org.agents[0]!;
    const a1 = org.agents[1]!;
    // Rare: two messages in one conversation, one in two others, one in the other organization.
    await plant(RARE, [`${a0}-c3`], 2);
    await plant(RARE, [`${a0}-c7`, `${a1}-c11`], 2);
    await plant(RARE, [`${other.agents[0]}-c1`], 1);
    // Frequent: 30 conversations of this organization, and the other organization too.
    const frequentHere = Array.from({ length: 15 }, (_, n) => [`${a0}-c${n}`, `${a1}-c${n + 20}`]).flat();
    await plant(FREQUENT, frequentHere, FREQUENT_MESSAGES - 500);
    await plant(FREQUENT, [`${other.agents[0]}-c2`], 500);
  }, 60_000);

  afterAll(async () => {
    await teardown();
  });

  it("finds every conversation with a rarely used word once", async () => {
    const { seen, total } = await searchAll(org, RARE, 2);

    expect(total).toBe(3);
    expect([...seen].sort()).toEqual(await withMessage(org, RARE));

    const { conversations } = await conversationStore.searchConversations(RARE, { scope: orgScope(org.orgId), limit: 10 });
    expect(conversations.find((c) => c.conversationId === `${org.agents[0]}-c3`))
      .toMatchObject({ matchCount: 2, bestSnippet: expect.stringContaining(RARE) });
  });

  it("finds every conversation with a word in thousands of messages once", async () => {
    const { seen, total } = await searchAll(org, FREQUENT, 7);

    expect(total).toBe(30);
    expect(seen).toHaveLength(30);
    expect([...seen].sort()).toEqual(await withMessage(org, FREQUENT));
  });

  it("matches the conversation id and the contact, and pages through ties once", async () => {
    // Every conversation shares its update time: only a tie-break keeps the pages apart.
    const byContact = await searchAll(org, "contact-1", 4);
    const expected = org.agents.flatMap((a) => [1, ...Array.from({ length: 10 }, (_, n) => 10 + n)].map((n) => `${a}-c${n}`));
    expect(byContact.total).toBe(expected.length);
    expect([...byContact.seen].sort()).toEqual(expected.sort());

    const byId = await conversationStore.searchConversations(`${org.agents[1]}-c3`, { scope: orgScope(org.orgId), limit: 50 });
    expect(byId.conversations.map((c) => c.conversationId).sort()).toEqual(
      [`${org.agents[1]}-c3`, ...Array.from({ length: 10 }, (_, n) => `${org.agents[1]}-c3${n}`)].sort(),
    );
  });

  it("narrows to one agent and a contact", async () => {
    const agent = asInstanceSlug(org.agents[1]!);
    const result = await conversationStore.searchConversations(FREQUENT, {
      scope: orgScope(org.orgId),
      instanceId: agent,
      userIdentifier: "CONTACT-2",
      limit: 50,
    });

    expect(result.conversations.map((c) => c.conversationId).sort()).toEqual(
      Array.from({ length: 10 }, (_, n) => `${agent}-c${20 + n}`).sort(),
    );
    expect(result.total).toBe(10);
  });

  it("finds nothing of another organization", async () => {
    for (const term of [RARE, FREQUENT]) {
      const result = await conversationStore.searchConversations(term, { scope: orgScope(org.orgId), limit: 100 });
      expect(result.conversations.every((c) => org.agents.includes(c.instanceId!))).toBe(true);
    }
    const foreign = await conversationStore.searchConversations(RARE, {
      scope: orgScope(org.orgId),
      instanceId: asInstanceSlug(other.agents[0]!),
    });
    expect(foreign).toEqual({ conversations: [], total: 0 });
  });
});
