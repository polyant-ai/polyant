// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The dedupe UPDATE of `upsertMemory` against a real database: which vector a matched memory keeps.
 *
 * The extractor re-extracts the facts of the recent messages on every turn, so the same text comes back often.
 * When the closest memory has the same text from the same embedding provider and the new vector is the stored one up
 * to floating-point noise, the update leaves the vector columns alone (no HNSW or TOAST write). A changed text,
 * another provider, or a vector that moved (another model behind the same provider name) still gets the new vector.
 * Each test stores the row with a vector V0 and upserts with a vector chosen for the case. Self-skips without a
 * database.
 */

import { afterEach, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { upsertMemory } from "./memory-store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const AGENT = asInstanceSlug("itest-memory-keep-vector-agent");
const TEXT = "The customer prefers pickup in store";

const V0 = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 1));
const nudged = (scale: number) => V0.map((x, i) => x + scale * Math.cos(3 * i));
const NOISE = nudged(0.0005);   // cosine distance to V0 ~1e-7: the same vector, re-embedded
const MOVED = nudged(0.3);      // cosine distance to V0 ~0.04: above the 0.90 dedupe threshold, but another vector
const literal = (v: number[]) => `[${v.join(",")}]`;

/** Store the agent's memory with vector V0 and the given provider; returns its id. */
async function storeV0(content: string, provider: string): Promise<string> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO memories (instance_id, content, category, importance, embedding, embedding_provider)
    VALUES (${AGENT}, ${content}, 'general', 5, ${literal(V0)}::vector, ${provider}) RETURNING id::text`;
  return row.id;
}
/** The stored row, with its vector named by which of V0, NOISE, MOVED it equals. */
async function stored(id: string) {
  const [row] = await queryClient<{ content: string; category: string; importance: number; provider: string; vector: string }[]>`
    SELECT content, category, importance, embedding_provider AS provider,
           CASE WHEN embedding = ${literal(V0)}::vector THEN 'V0'
                WHEN embedding = ${literal(NOISE)}::vector THEN 'NOISE'
                WHEN embedding = ${literal(MOVED)}::vector THEN 'MOVED' END AS vector
    FROM memories WHERE id = ${id}::uuid`;
  return row;
}
const upsert = (content: string, embedding: number[], provider = "openai") =>
  upsertMemory({ instanceId: AGENT, content, category: "preference", importance: 8, embedding, dimensions: 1536, provider });

describe.skipIf(!DB_AVAILABLE)("upsertMemory dedupe update (integration)", () => {
  // Each test starts from no memory of the agent, even when the one before failed half-way.
  afterEach(async () => {
    await queryClient`DELETE FROM memories WHERE instance_id = ${AGENT}`;
  });

  it("keeps the stored vector when the same text comes back from the same provider, and applies the rest", async () => {
    const id = await storeV0(TEXT, "openai");

    expect(await upsert(TEXT, NOISE)).toEqual({ id, content: TEXT, event: "UPDATE" });

    expect(await stored(id)).toEqual({ content: TEXT, category: "preference", importance: 8, provider: "openai", vector: "V0" });
  });

  it("writes the new vector when the text changed", async () => {
    const id = await storeV0(TEXT, "openai");

    await upsert("The customer prefers pickup at the store", NOISE);

    expect(await stored(id)).toMatchObject({ content: "The customer prefers pickup at the store", vector: "NOISE" });
  });

  it("writes the new vector when the same text was embedded by another provider", async () => {
    const id = await storeV0(TEXT, "bedrock");

    await upsert(TEXT, NOISE);

    expect(await stored(id)).toMatchObject({ provider: "openai", vector: "NOISE" });
  });

  it("writes the new vector when the same provider name now embeds the text elsewhere (another model behind it)", async () => {
    const id = await storeV0(TEXT, "openai");

    await upsert(TEXT, MOVED);

    expect(await stored(id)).toMatchObject({ content: TEXT, vector: "MOVED" });
  });
});
