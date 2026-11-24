// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The memory store against a real Postgres: which vector column a save fills,
 * when a save updates instead of adding, what a search returns, and which rows
 * a delete or a count reaches across agents and organizations. Self-skips when
 * no migrated database is reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { orgScope, type TenantScope } from "../authz/scope-filter.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import {
  countMemories,
  deleteAllMemories,
  deleteMemoryForInstance,
  searchByVector,
  searchMemories,
  upsertMemory,
} from "./memory-store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-memstore";
const AGENT = asInstanceSlug(`${MARKER}-agent`);
const SIBLING = asInstanceSlug(`${MARKER}-sibling`);
const FOREIGN = asInstanceSlug(`${MARKER}-foreign`);

let scope: TenantScope;
let foreignScope: TenantScope;

/** A unit vector along axis `i`: two different axes are orthogonal (similarity 0). */
function axis(i: number, dims: 1024 | 1536): number[] {
  return Array.from({ length: dims }, (_, k) => (k === i ? 1 : 0));
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM memories WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

async function createOrgWithAgents(slug: string, agents: string[]): Promise<string> {
  const [{ id: orgId }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${slug}, 'm', false) RETURNING id`;
  const [{ id: wsId }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${slug}, 'm', false) RETURNING id`;
  for (const agent of agents) {
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${agent}, 'm', ${wsId})`;
  }
  return orgId;
}

async function save(agent: typeof AGENT, content: string, embedding: number[], extra: { category?: string } = {}) {
  return upsertMemory({
    instanceId: agent,
    content,
    embedding,
    dimensions: embedding.length as 1024 | 1536,
    provider: "openai",
    ...extra,
  });
}

async function stored(id: string) {
  const [row] = await queryClient<
    { content: string; has1536: boolean; has1024: boolean; provider: string; updated: string }[]
  >`
    SELECT content, embedding IS NOT NULL AS has1536, embedding_1024 IS NOT NULL AS has1024,
           embedding_provider AS provider, updated_at AS updated
    FROM memories WHERE id = ${id}`;
  return row;
}

describe.skipIf(!DB_AVAILABLE)("memory store (integration)", () => {
  beforeAll(async () => {
    await teardown();
    scope = orgScope(await createOrgWithAgents(MARKER, [AGENT, SIBLING]));
    foreignScope = orgScope(await createOrgWithAgents(`${MARKER}-other`, [FOREIGN]));
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM memories WHERE instance_id LIKE ${MARKER + "%"}`;
  });

  afterAll(teardown);

  it("stores a 1536-dim fact in `embedding` and a 1024-dim fact in `embedding_1024`, with the provider", async () => {
    const wide = await save(AGENT, "likes pizza", axis(0, 1536));
    const narrow = await upsertMemory({
      instanceId: AGENT, content: "likes tea", embedding: axis(0, 1024), dimensions: 1024, provider: "bedrock",
    });

    expect(wide.event).toBe("ADD");
    expect(narrow.event).toBe("ADD");
    expect(await stored(wide.id)).toMatchObject({ content: "likes pizza", has1536: true, has1024: false, provider: "openai" });
    expect(await stored(narrow.id)).toMatchObject({ content: "likes tea", has1536: false, has1024: true, provider: "bedrock" });
  });

  it("a fact close to one the agent holds replaces it; an unrelated one, or another agent's, is added", async () => {
    const first = await save(AGENT, "likes pasta", axis(1, 1024), { category: "preference" });
    const before = await stored(first.id);

    const again = await save(AGENT, "likes pasta a lot", axis(1, 1024));
    const unrelated = await save(AGENT, "lives in Turin", axis(2, 1024));
    const sibling = await save(SIBLING, "likes pasta", axis(1, 1024));

    expect(again).toEqual({ id: first.id, content: "likes pasta a lot", event: "UPDATE" });
    const after = await stored(first.id);
    expect(after!.content).toBe("likes pasta a lot");
    expect(new Date(after!.updated).getTime()).toBeGreaterThan(new Date(before!.updated).getTime());
    expect(unrelated.event).toBe("ADD");
    expect(sibling.event).toBe("ADD");
    expect(await countMemories(AGENT)).toBe(2);
    expect(await countMemories(SIBLING)).toBe(1);
  });

  it("a duplicate check in one dimension ignores the agent's facts stored in the other", async () => {
    const wide = await save(AGENT, "old 1536 fact", axis(3, 1536));

    const narrow = await save(AGENT, "new 1024 fact", axis(3, 1024));

    expect(narrow.event).toBe("ADD");
    expect(narrow.id).not.toBe(wide.id);
  });

  it("a vector search returns the agent's facts in that dimension, nearest first, with similarity = 1 - distance", async () => {
    const exact = await save(AGENT, "exact", axis(4, 1024));
    const orthogonal = await save(AGENT, "orthogonal", axis(5, 1024));
    await save(AGENT, "other dimension", axis(4, 1536));
    await save(SIBLING, "sibling's", axis(4, 1024));

    const results = await searchByVector(axis(4, 1024), AGENT, 10, 1024);

    expect(results.map((r) => r.id)).toEqual([exact.id, orthogonal.id]);
    expect(results[0]!.similarity).toBeCloseTo(1);
    expect(results[1]!.similarity).toBeCloseTo(0);
    expect(results.every((r) => r.instanceId === AGENT && Number.isFinite(r.similarity))).toBe(true);
    expect(await searchByVector(axis(4, 1024), AGENT, 1, 1024)).toHaveLength(1);
  });

  it("a listing filters by literal text and category, newest first, paginated, inside the caller's organization", async () => {
    await save(AGENT, "discount 100% guaranteed", axis(6, 1024), { category: "offer" });
    await save(AGENT, "discount 1000 guaranteed", axis(7, 1024), { category: "offer" });
    await save(AGENT, "discount_code ABC", axis(8, 1024), { category: "general" });

    const percent = await searchMemories(AGENT, { scope, search: "100%" });
    expect(percent.memories.map((m) => m.content)).toEqual(["discount 100% guaranteed"]);
    expect(percent.total).toBe(1);

    const underscore = await searchMemories(AGENT, { scope, search: "t_1" });
    expect(underscore.total).toBe(0);

    const offers = await searchMemories(AGENT, { scope, category: "offer" });
    expect(offers.memories.map((m) => m.content)).toEqual(["discount 1000 guaranteed", "discount 100% guaranteed"]);

    const page = await searchMemories(AGENT, { scope, limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.memories.map((m) => m.content)).toEqual(["discount 1000 guaranteed"]);

    expect(await searchMemories(AGENT, { scope: foreignScope })).toEqual({ memories: [], total: 0 });
  });

  it("deleting one fact needs its agent and the agent's organization", async () => {
    const fact = await save(AGENT, "to delete", axis(9, 1024));

    expect(await deleteMemoryForInstance(fact.id, SIBLING, scope)).toBe(false);
    expect(await deleteMemoryForInstance(fact.id, AGENT, foreignScope)).toBe(false);
    expect(await countMemories(AGENT)).toBe(1);

    expect(await deleteMemoryForInstance(fact.id, AGENT, scope)).toBe(true);
    expect(await countMemories(AGENT)).toBe(0);
    expect(await deleteMemoryForInstance(fact.id, AGENT, scope)).toBe(false);
  });

  it("deleting all facts of an agent counts them, leaves other agents alone, and does nothing from another organization", async () => {
    await save(AGENT, "a", axis(10, 1024));
    await save(AGENT, "b", axis(11, 1024));
    await save(SIBLING, "c", axis(10, 1024));

    expect(await deleteAllMemories(AGENT, foreignScope, db)).toBe(0);
    expect(await countMemories(AGENT)).toBe(2);

    expect(await deleteAllMemories(AGENT, scope, db)).toBe(2);
    expect(await countMemories(AGENT)).toBe(0);
    expect(await countMemories(SIBLING)).toBe(1);
  });
});
