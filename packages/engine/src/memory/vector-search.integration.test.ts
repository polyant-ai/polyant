// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A memory search asked for k memories of an agent returns k when the agent
 * has them, and saving a fact the agent already holds updates it, whichever
 * plan Postgres picks.
 *
 * The planner reaches for the deployment-wide HNSW index once an agent holds
 * enough memories. That index hands back its `ef_search` nearest rows of the
 * WHOLE table and the per-agent filter runs afterwards, so an agent that owns
 * a fraction of those rows received a fraction of the results, and the
 * duplicate check found no duplicate when other agents' rows were nearer.
 * On a small table the planner picks that plan once computing a distance looks
 * expensive, so the session raises `cpu_operator_cost`; the pool holds a single
 * connection so every query runs in that session. (Turning sorts off instead
 * would also disable the exact plan the fallback relies on.)
 *
 * Self-skips when no migrated database is reachable.
 */

import { vi } from "vitest";

vi.hoisted(() => {
  process.env.POSTGRES_POOL_MAX = "1";
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { _setHnswIterativeScanForTests } from "../database/vector-scan.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { searchByVector, upsertMemory } from "./memory-store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const RUN = Date.now();
const AGENT = asInstanceSlug(`itest-msearch-${RUN}`);
const OTHER = asInstanceSlug(`itest-msearch-other-${RUN}`);
const AGENT_ROWS = 150;
const OTHER_ROWS = 1350;
/**
 * How many of the other agent's rows are nearer the query than the agent's
 * near-duplicate: five times the index's first window (`hnsw.ef_search`, 40),
 * so that window holds none of the agent's rows. The rest are far away. Making
 * every other row nearer only lengthens the walk the index must finish before
 * it reaches the duplicate, and an approximate walk that long does not always
 * finish: it ran out and the duplicate was saved twice.
 */
const OTHER_NEARER = 200;
const K = 20;

/** A fixed pseudo-random vector, the same on every run. */
function vector(seed: number): number[] {
  let x = seed;
  return Array.from({ length: 1024 }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  });
}

/** `base` moved by `weight` toward a random direction: lower weight, higher similarity. */
function near(base: number[], seed: number, weight: number): number[] {
  const noise = vector(seed);
  return base.map((v, i) => v + weight * noise[i]!);
}

async function seed(slug: string, vectors: number[][]): Promise<string[]> {
  const rows = vectors.map((v, i) => ({
    instance_id: slug,
    content: `fact ${i}`,
    embedding_1024: `[${v.join(",")}]`,
    embedding_provider: "openai",
  }));
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 250) {
    const inserted = await queryClient<{ id: string }[]>`
      INSERT INTO memories ${queryClient(rows.slice(i, i + 250))} RETURNING id`;
    ids.push(...inserted.map((r) => r.id));
  }
  return ids;
}

async function exactTopIds(query: number[]): Promise<string[]> {
  return await queryClient.begin(async (tx) => {
    await tx`SET LOCAL enable_indexscan = off`;
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM memories WHERE instance_id = ${AGENT}
      ORDER BY embedding_1024 <=> ${`[${query.join(",")}]`}::vector LIMIT ${K}`;
    return rows.map((r) => r.id);
  });
}

describe.skipIf(!DB_AVAILABLE)("memory vector search on the HNSW plan (integration)", () => {
  const query = vector(7_000_000);
  let duplicateId = "";

  beforeAll(async () => {
    // The agent's nearest memory is a near-duplicate of the query (similarity ~0.96);
    // OTHER_NEARER of the other agent's rows are nearer still, so the index's first
    // candidates are all theirs.
    const agentVectors = [near(query, 11, 0.3), ...Array.from({ length: AGENT_ROWS - 1 }, (_, i) => vector(i + 1))];
    [duplicateId] = await seed(AGENT, agentVectors);
    await seed(OTHER, Array.from({ length: OTHER_ROWS }, (_, i) =>
      i < OTHER_NEARER ? near(query, 1_000_000 + i, 0.1) : vector(2_000_000 + i)));
    await queryClient`ANALYZE memories`;
    await queryClient`SET cpu_operator_cost = 10`;
  }, 120_000);

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    _setHnswIterativeScanForTests(undefined);
    await queryClient`RESET cpu_operator_cost`;
    await queryClient`DELETE FROM memories WHERE instance_id IN (${AGENT}, ${OTHER})`;
  });

  it("uses the vector index for the agent's search", async () => {
    // Guards the premise: without this plan the tests below prove nothing.
    const plan = await queryClient.unsafe(
      `EXPLAIN SELECT id FROM memories WHERE instance_id = $1 ORDER BY embedding_1024 <=> $2::vector LIMIT ${K}`,
      [AGENT, `[${query.join(",")}]`],
    );
    expect(plan.map((r) => Object.values(r)[0]).join("\n")).toContain("idx_memories_embedding_1024_cosine");
  });

  it("returns the k memories asked for, nearest first", async () => {
    const results = await searchByVector(query, AGENT, K, 1024);

    expect(results).toHaveLength(K);
    expect(results.every((r) => r.instanceId === AGENT)).toBe(true);
    const scores = results.map((r) => r.similarity);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("returns the exact k nearest memories where the index cannot scan on", async () => {
    _setHnswIterativeScanForTests(false);
    try {
      const results = await searchByVector(query, AGENT, K, 1024);

      const exact = await exactTopIds(query);
      expect(exact).toHaveLength(K);
      expect(results.map((r) => r.id)).toEqual(exact);
    } finally {
      _setHnswIterativeScanForTests(undefined);
    }
  });

  it("updates the agent's near-duplicate instead of saving the fact twice", async () => {
    const result = await upsertMemory({
      instanceId: AGENT,
      content: "the same fact, said again",
      embedding: query,
      dimensions: 1024,
      provider: "openai",
    });

    expect(result).toMatchObject({ event: "UPDATE", id: duplicateId });
  });
});
