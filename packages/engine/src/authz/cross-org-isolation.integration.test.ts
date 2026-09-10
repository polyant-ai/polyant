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

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { queryClient } from "../database/client.js";
import { orgScope } from "./scope-filter.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import {
  searchMemories,
  deleteMemoryForInstance,
  deleteAllMemories,
} from "../memory/memory-store.js";
import { conversationStore } from "../conversations/store.js";
import { NO_TRANSACTION } from "../database/client.js";


const DB_AVAILABLE = await resolveDatabaseAvailability();

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
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${`agent ${label}`}, ${workspaceId})`;

  const convId = `${slug}-conv`;
  await queryClient`
    INSERT INTO conversations (conversation_id, instance_id, channel, source)
    VALUES (${convId}, ${slug}, 'web', 'user')`;

  const [{ id: memoryId }] = await queryClient<{ id: string }[]>`
    INSERT INTO memories (instance_id, content, category, importance, embedding)
    VALUES (${slug}, ${`secret of ${label}`}, 'general', 5, ${ZERO_EMBEDDING}::vector)
    RETURNING id`;

  return { orgId, workspaceId, slug, convId, memoryId };
}

async function teardown(): Promise<void> {
  // Children first (FK order), all keyed by the run marker.
  await queryClient`DELETE FROM memories WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
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
      const result = await searchMemories(asInstanceSlug(orgB.slug), { scope: orgScope(orgA.orgId) });
      expect(result.total).toBe(0);
      expect(result.memories).toHaveLength(0);
    });

    it("should_return_OrgB_rows_for_the_owning_org (control)", async () => {
      const result = await searchMemories(asInstanceSlug(orgB.slug), { scope: orgScope(orgB.orgId) });
      expect(result.total).toBe(1);
      expect(result.memories[0].content).toBe("secret of b");
    });

    it("should_not_delete_an_OrgB_memory_for_an_OrgA_caller (param-IDOR on delete)", async () => {
      const deleted = await deleteMemoryForInstance(orgB.memoryId, asInstanceSlug(orgB.slug), orgScope(orgA.orgId));
      expect(deleted).toBe(false);
      // The row must still be there for its owner.
      const stillThere = await searchMemories(asInstanceSlug(orgB.slug), { scope: orgScope(orgB.orgId) });
      expect(stillThere.total).toBe(1);
    });

    it("should_not_delete_all_OrgB_memories_for_an_OrgA_caller", async () => {
      await deleteAllMemories(asInstanceSlug(orgB.slug), orgScope(orgA.orgId), NO_TRANSACTION);
      const stillThere = await searchMemories(asInstanceSlug(orgB.slug), { scope: orgScope(orgB.orgId) });
      expect(stillThere.total).toBe(1);
    });
  });

  describe("conversations", () => {
    it("should_treat_an_OrgB_conversation_as_not_found_for_an_OrgA_caller (param-IDOR)", async () => {
      const conv = await conversationStore.getConversation(orgB.convId, orgScope(orgA.orgId));
      expect(conv).toBeNull();
    });

    it("should_return_an_OrgB_conversation_for_the_owning_org (control)", async () => {
      const conv = await conversationStore.getConversation(orgB.convId, orgScope(orgB.orgId));
      expect(conv?.conversationId).toBe(orgB.convId);
    });

    it("should_list_only_caller_org_conversations_when_no_slug_is_given (aggregate-leak)", async () => {
      const { conversations } = await conversationStore.listConversations({
        scope: orgScope(orgA.orgId),
        limit: 100,
      });
      const slugs = new Set(conversations.map((c) => c.instanceId));
      expect(slugs.has(asInstanceSlug(orgA.slug))).toBe(true);
      expect(slugs.has(asInstanceSlug(orgB.slug))).toBe(false);
    });
  });

  /**
   * The mutations, which the read cases above never covered.
   *
   * Their tenancy used to live entirely in the caller: the controller ran
   * `loadConversationScoped` a few lines earlier, and the store keyed every
   * statement on `conversation_id` alone across nine tables. An ordering no type
   * checked and no test pinned — and the reset hook calls `renameConversation`
   * without it. Here the store itself is asked to refuse.
   */
  describe("conversation mutations", () => {
    it("should_not_rename_an_OrgB_conversation_for_an_OrgA_caller", async () => {
      const renamed = await conversationStore.renameConversation(
        orgB.convId,
        `${orgB.convId}#stolen`,
        orgScope(orgA.orgId),
        "renamed by a stranger",
      );
      expect(renamed).toBe(false);

      // The row is untouched under its own id, and the new id was never created.
      const own = await conversationStore.getConversation(orgB.convId, orgScope(orgB.orgId));
      expect(own?.conversationId).toBe(orgB.convId);
      const stolen = await conversationStore.getConversation(
        `${orgB.convId}#stolen`,
        orgScope(orgB.orgId),
      );
      expect(stolen).toBeNull();
    });

    it("should_not_delete_an_OrgB_conversation_for_an_OrgA_caller", async () => {
      const deleted = await conversationStore.deleteConversation(
        orgB.convId,
        orgScope(orgA.orgId),
      );
      expect(deleted).toBe(false);

      const stillThere = await conversationStore.getConversation(
        orgB.convId,
        orgScope(orgB.orgId),
      );
      expect(stillThere?.conversationId).toBe(orgB.convId);
    });

    it("should_let_the_owning_org_rename_and_delete_its_own_conversation (control)", async () => {
      const convId = `${orgA.slug}-conv-own`;
      await queryClient`
        INSERT INTO conversations (conversation_id, instance_id, channel, source)
        VALUES (${convId}, ${orgA.slug}, 'web', 'user')`;

      const archived = `${convId}#archived`;
      const renamed = await conversationStore.renameConversation(
        convId,
        archived,
        orgScope(orgA.orgId),
      );
      expect(renamed).toBe(true);

      const deleted = await conversationStore.deleteConversation(archived, orgScope(orgA.orgId));
      expect(deleted).toBe(true);
    });
  });
});
