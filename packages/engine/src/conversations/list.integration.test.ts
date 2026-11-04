// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation list of an organization: newest activity first across all
 * its agents, pages that neither repeat nor skip a conversation, filters that
 * narrow it, and nothing from another organization.
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
const MARKER = `itest-clist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const BASE = Date.parse("2026-03-01T10:00:00Z");

interface Seeded {
  orgId: string;
  agents: string[];
}

/** An organization with `agents` agents; conversation `n` of agent `a` is updated `n` minutes after BASE. */
async function seedOrg(label: string, agents: number, perAgent: number): Promise<Seeded> {
  const slug = `${MARKER}-${label}`;
  const [{ id: orgId }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${slug}, ${slug}, false) RETURNING id`;
  const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${slug}, ${slug}, false) RETURNING id`;
  const slugs = Array.from({ length: agents }, (_, a) => `${slug}-a${a}`);
  for (const agent of slugs) {
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${agent}, ${agent}, ${workspaceId})`;
  }
  const rows = slugs.flatMap((agent, a) =>
    Array.from({ length: perAgent }, (_, n) => ({
      conversation_id: `${agent}-c${n}`,
      instance_id: agent,
      channel: n % 2 === 0 ? "web" : "whatsapp",
      source: n % 3 === 0 ? "api" : "user",
      user_identifier: `contact-${a}-${n}@example.test`,
      // Agents share timestamps: every page boundary falls between ties.
      updated_at: new Date(BASE + n * 60_000).toISOString(),
    })),
  );
  await queryClient`INSERT INTO conversations ${queryClient(rows)}`;
  return { orgId, agents: slugs };
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversations WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

/** What the list must return, computed from the seeded rows without the store. */
async function expectedIds(orgAgents: string[], where = queryClient`true`): Promise<string[]> {
  const rows = await queryClient<{ conversation_id: string }[]>`
    SELECT conversation_id FROM conversations
    WHERE instance_id IN ${queryClient(orgAgents)} AND ${where}
    ORDER BY updated_at DESC, id DESC`;
  return rows.map((r) => r.conversation_id);
}

describe.skipIf(!DB_AVAILABLE)("conversationStore.listConversations (integration)", () => {
  let org: Seeded;
  let other: Seeded;

  beforeAll(async () => {
    await teardown();
    org = await seedOrg("org", 3, 9);
    other = await seedOrg("other", 2, 5);
  });

  afterAll(async () => {
    await teardown();
  });

  it("walks every conversation of the organization once, newest activity first", async () => {
    const seen: string[] = [];
    let total = -1;
    for (let offset = 0; offset < 40; offset += 4) {
      const page = await conversationStore.listConversations({ scope: orgScope(org.orgId), limit: 4, offset });
      total = page.total;
      seen.push(...page.conversations.map((c) => c.conversationId));
    }

    expect(total).toBe(27);
    expect(seen).toEqual(await expectedIds(org.agents));
  });

  it("returns the row fields of each conversation", async () => {
    const { conversations } = await conversationStore.listConversations({ scope: orgScope(org.orgId), limit: 1 });

    expect(conversations[0]).toMatchObject({
      conversationId: expect.stringMatching(/-c8$/),
      channel: "web",
      instanceName: expect.stringContaining(MARKER),
      messageCount: 0,
      totalTokens: 0,
      updatedAt: new Date(BASE + 8 * 60_000),
    });
  });

  it("narrows to one agent, a source, a contact and a time window", async () => {
    const scope = orgScope(org.orgId);
    const agent = asInstanceSlug(org.agents[1]!);

    const byAgent = await conversationStore.listConversations({ scope, instanceId: agent, limit: 100 });
    expect(byAgent.conversations.map((c) => c.conversationId))
      .toEqual(await expectedIds([agent]));
    expect(byAgent.total).toBe(9);

    const bySource = await conversationStore.listConversations({ scope, source: "api", limit: 100 });
    expect(bySource.conversations.map((c) => c.conversationId))
      .toEqual(await expectedIds(org.agents, queryClient`source = 'api'`));
    expect(bySource.total).toBe(9);

    const byContact = await conversationStore.listConversations({ scope, userIdentifier: "CONTACT-2-4", limit: 100 });
    expect(byContact.conversations.map((c) => c.conversationId)).toEqual([`${org.agents[2]}-c4`]);

    const since = new Date(BASE + 3 * 60_000);
    const until = new Date(BASE + 6 * 60_000);
    const byWindow = await conversationStore.listConversations({ scope, updatedSince: since, updatedUntil: until, limit: 100 });
    expect(byWindow.conversations.map((c) => c.conversationId))
      .toEqual(await expectedIds(org.agents, queryClient`updated_at >= ${since.toISOString()}::timestamptz AND updated_at < ${until.toISOString()}::timestamptz`));
    expect(byWindow.total).toBe(9);
  });

  it("lists nothing of another organization, even for its agent", async () => {
    const scope = orgScope(org.orgId);

    const all = await conversationStore.listConversations({ scope, limit: 100 });
    expect(all.conversations.every((c) => org.agents.includes(c.instanceId!))).toBe(true);

    const foreign = await conversationStore.listConversations({ scope, instanceId: asInstanceSlug(other.agents[0]!) });
    expect(foreign).toEqual({ conversations: [], total: 0 });
  });
});
