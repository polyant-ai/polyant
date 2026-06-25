// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for RBAC Stream 2 — store-layer cross-org isolation (the
 * launch gate). Exercises the live `buildOrgScopedAgentFilter` against a
 * migrated Postgres through the real conversation + memory stores, covering
 * BOTH leak vectors the issue closes:
 *
 *   1. param-IDOR  — an Org-A caller passing an Org-B agent slug gets zero rows.
 *   2. aggregate-leak — an aggregate list (no slug) returns only caller-org rows.
 *
 * Self-skips when no migrated database is reachable, so a bare `npm test`
 * without a DB stays green. Run it for real with a database up:
 *   docker compose up -d postgres && npm run db:migrate && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db, queryClient } from "../database/client.js";
import { asAgentSlug } from "../instances/identifiers.js";
import {
  searchMemories,
  deleteMemoryForInstance,
  deleteAllMemories,
} from "../memory/memory-store.js";
import { conversationStore } from "../conversations/store.js";

async function dbReachable(): Promise<boolean> {
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("db probe timeout")), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

const DB_AVAILABLE = await dbReachable();

// Unique suffix keeps parallel/repeat runs from colliding on the slug/email
// unique constraints; the afterAll teardown removes everything by this marker.
const MARKER = `itest-xorg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ZERO_EMBEDDING = `[${Array.from({ length: 1536 }, () => 0).join(",")}]`;

interface Tenant {
  orgId: string;
  workspaceId: string;
  slug: string;
  convId: string;
  memoryId: string;
}

async function seedTenant(label: string): Promise<Tenant> {
  const slug = `${MARKER}-${label}`;
  const [{ id: orgId }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default)
    VALUES (${slug}, ${`org ${label}`}, false)
    RETURNING id`;
  const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default)
    VALUES (${orgId}, ${slug}, ${`ws ${label}`}, false)
    RETURNING id`;
  await queryClient`
    INSERT INTO agents (slug, name, workspace_id)
    VALUES (${slug}, ${`agent ${label}`}, ${workspaceId})`;

  const convId = `${slug}-conv`;
  await queryClient`
    INSERT INTO conversations (conversation_id, agent_id, channel, source)
    VALUES (${convId}, ${slug}, 'web', 'user')`;

  const [{ id: memoryId }] = await queryClient<{ id: string }[]>`
    INSERT INTO memories (agent_id, content, category, importance, embedding)
    VALUES (${slug}, ${`secret of ${label}`}, 'general', 5, ${ZERO_EMBEDDING}::vector)
    RETURNING id`;

  return { orgId, workspaceId, slug, convId, memoryId };
}

async function teardown(): Promise<void> {
  // Children first (FK order), all keyed by the run marker.
  await queryClient`DELETE FROM memories WHERE agent_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE agent_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM agents WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("RBAC Stream 2 — store-layer cross-org isolation", () => {
  let orgA: Tenant;
  let orgB: Tenant;

  beforeAll(async () => {
    await teardown();
    orgA = await seedTenant("a");
    orgB = await seedTenant("b");
  });

  afterAll(async () => {
    await teardown();
  });

  describe("memories", () => {
    it("should_return_zero_rows_when_OrgA_caller_passes_OrgB_agent_slug (param-IDOR)", async () => {
      const result = await searchMemories(asAgentSlug(orgB.slug), { orgId: orgA.orgId });
      expect(result.total).toBe(0);
      expect(result.memories).toHaveLength(0);
    });

    it("should_return_OrgB_rows_for_the_owning_org (control)", async () => {
      const result = await searchMemories(asAgentSlug(orgB.slug), { orgId: orgB.orgId });
      expect(result.total).toBe(1);
      expect(result.memories[0].content).toBe("secret of b");
    });

    it("should_not_delete_an_OrgB_memory_for_an_OrgA_caller (param-IDOR on delete)", async () => {
      const deleted = await deleteMemoryForInstance(orgB.memoryId, asAgentSlug(orgB.slug), orgA.orgId);
      expect(deleted).toBe(false);
      // The row must still be there for its owner.
      const stillThere = await searchMemories(asAgentSlug(orgB.slug), { orgId: orgB.orgId });
      expect(stillThere.total).toBe(1);
    });

    it("should_not_delete_all_OrgB_memories_for_an_OrgA_caller", async () => {
      await deleteAllMemories(asAgentSlug(orgB.slug), orgA.orgId);
      const stillThere = await searchMemories(asAgentSlug(orgB.slug), { orgId: orgB.orgId });
      expect(stillThere.total).toBe(1);
    });
  });

  describe("conversations", () => {
    it("should_treat_an_OrgB_conversation_as_not_found_for_an_OrgA_caller (param-IDOR)", async () => {
      const conv = await conversationStore.getConversation(orgB.convId, orgA.orgId);
      expect(conv).toBeNull();
    });

    it("should_return_an_OrgB_conversation_for_the_owning_org (control)", async () => {
      const conv = await conversationStore.getConversation(orgB.convId, orgB.orgId);
      expect(conv?.conversationId).toBe(orgB.convId);
    });

    it("should_list_only_caller_org_conversations_when_no_slug_is_given (aggregate-leak)", async () => {
      const { conversations } = await conversationStore.listConversations({
        orgId: orgA.orgId,
        limit: 100,
      });
      const slugs = new Set(conversations.map((c) => c.agentId));
      expect(slugs.has(asAgentSlug(orgA.slug))).toBe(true);
      expect(slugs.has(asAgentSlug(orgB.slug))).toBe(false);
    });
  });
});
