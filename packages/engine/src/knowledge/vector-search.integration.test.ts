// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A vector search asked for k chunks of an agent returns k chunks when the
 * agent has them, whichever plan Postgres picks.
 *
 * The planner reaches for the deployment-wide HNSW index once an agent holds
 * thousands of chunks. That index hands back its `ef_search` nearest rows of
 * the WHOLE table and the per-agent filter runs afterwards, so an agent that
 * owns a fraction of those rows received a fraction of the results. Statistics
 * that make the planner choose the index cost minutes of inserts; turning sorts
 * off for the session gives the same plan on a small table, which is why the
 * pool here holds a single connection.
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
import { asInstanceSlug } from "../instances/identifiers.js";
import { _setHnswIterativeScanForTests } from "../database/vector-scan.js";
import { searchByVector } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const RUN = Date.now();
const AGENT = asInstanceSlug(`itest-vsearch-${RUN}`);
const OTHER = asInstanceSlug(`itest-vsearch-other-${RUN}`);
const AGENT_CHUNKS = 150;
const OTHER_CHUNKS = 1350;
const K = 20;

/** A fixed pseudo-random unit-free vector, the same on every run. */
function vector(seed: number): number[] {
  let x = seed;
  return Array.from({ length: 1024 }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  });
}

async function seed(slug: string, count: number, seedOffset: number): Promise<void> {
  const [doc] = await queryClient<{ id: string }[]>`
    INSERT INTO knowledge_documents (instance_id, filename, mime_type, raw_content, status)
    VALUES (${slug}, 'doc.txt', 'text/plain', 'x', 'ready') RETURNING id`;
  const rows = Array.from({ length: count }, (_, i) => ({
    document_id: doc!.id,
    instance_id: slug,
    content: `chunk ${i}`,
    embedding_1024: `[${vector(seedOffset + i).join(",")}]`,
    chunk_index: i,
  }));
  for (let i = 0; i < rows.length; i += 250) {
    await queryClient`INSERT INTO knowledge_chunks ${queryClient(rows.slice(i, i + 250))}`;
  }
}

/**
 * The agent's k nearest chunks, ranked here rather than by Postgres: with sorts
 * off for the session, an ORDER BY can still be planned on the vector index,
 * which would make the expected answer as short as the one under test.
 */
async function exactTopIds(query: number[]): Promise<string[]> {
  const rows = await queryClient<{ id: string; distance: number }[]>`
    SELECT id, embedding_1024 <=> ${`[${query.join(",")}]`}::vector AS distance
    FROM knowledge_chunks WHERE instance_id = ${AGENT}`;
  return rows
    .sort((a, b) => a.distance - b.distance)
    .slice(0, K)
    .map((r) => r.id);
}

describe.skipIf(!DB_AVAILABLE)("searchByVector on the HNSW plan (integration)", () => {
  const query = vector(7_000_000);

  beforeAll(async () => {
    await seed(AGENT, AGENT_CHUNKS, 0);
    await seed(OTHER, OTHER_CHUNKS, 1_000_000);
    await queryClient`SET enable_sort = off`;
  }, 120_000);

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    _setHnswIterativeScanForTests(undefined);
    await queryClient`RESET enable_sort`;
    await queryClient`DELETE FROM knowledge_documents WHERE instance_id IN (${AGENT}, ${OTHER})`;
  });

  it("uses the vector index for the agent's search", async () => {
    // Guards the premise: without this plan the tests below prove nothing.
    const plan = await queryClient.unsafe(
      `EXPLAIN SELECT id FROM knowledge_chunks WHERE instance_id = $1 ORDER BY embedding_1024 <=> $2::vector LIMIT ${K}`,
      [AGENT, `[${query.join(",")}]`],
    );
    expect(plan.map((r) => Object.values(r)[0]).join("\n")).toContain("idx_knowledge_chunks_embedding_1024_cosine");
  });

  it("returns the k chunks asked for, nearest first", async () => {
    const results = await searchByVector(query, AGENT, K, 1024);

    expect(results).toHaveLength(K);
    const scores = results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("returns the exact k nearest chunks where the index cannot scan on", async () => {
    _setHnswIterativeScanForTests(false);
    try {
      const results = await searchByVector(query, AGENT, K, 1024);

      expect(results.map((r) => r.id)).toEqual(await exactTopIds(query));
    } finally {
      _setHnswIterativeScanForTests(undefined);
    }
  });
});
