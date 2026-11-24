// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resetting an agent's embedding space against a real Postgres: its memories,
 * knowledge documents and chunks go (they are keyed by the agent's SLUG), its
 * embedding dimension takes the new value (keyed by its id), and another agent
 * keeps everything. Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug, asInstanceUuid } from "../instances/identifiers.js";
import { resetEmbeddingSpace } from "./embedding-reset.service.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-embed-reset";
const AGENT = `${MARKER}-agent`;
const OTHER = `${MARKER}-other`;
const VECTOR = `[${Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
const ids: Record<string, string> = {};

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM memories WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM knowledge_documents WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

/** An agent on 1536 dimensions with two memories and one document of two chunks. */
async function furnish(slug: string): Promise<void> {
  const [{ id }] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id, embedding_dim)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1), 1536) RETURNING id`;
  ids[slug] = id;
  await queryClient`
    INSERT INTO memories (instance_id, content, embedding) VALUES
      (${slug}, 'a', ${VECTOR}::vector), (${slug}, 'b', ${VECTOR}::vector)`;
  const [{ id: docId }] = await queryClient<{ id: string }[]>`
    INSERT INTO knowledge_documents (instance_id, filename, mime_type, size_bytes, raw_content, content_hash)
    VALUES (${slug}, 'doc.md', 'text/markdown', 1, 'x', 'h') RETURNING id`;
  await queryClient`
    INSERT INTO knowledge_chunks (document_id, instance_id, content, embedding, chunk_index) VALUES
      (${docId}, ${slug}, 'c0', ${VECTOR}::vector, 0), (${docId}, ${slug}, 'c1', ${VECTOR}::vector, 1)`;
}

async function holdings(slug: string) {
  const [row] = await queryClient<{ memories: number; documents: number; chunks: number; dim: number }[]>`
    SELECT (SELECT count(*)::int FROM memories WHERE instance_id = ${slug}) AS memories,
           (SELECT count(*)::int FROM knowledge_documents WHERE instance_id = ${slug}) AS documents,
           (SELECT count(*)::int FROM knowledge_chunks WHERE instance_id = ${slug}) AS chunks,
           (SELECT embedding_dim FROM instances WHERE slug = ${slug}) AS dim`;
  return row;
}

describe.skipIf(!DB_AVAILABLE)("embedding space reset (integration)", () => {
  beforeAll(async () => {
    await teardown();
    await furnish(AGENT);
    await furnish(OTHER);
  });

  afterAll(teardown);

  it("wipes the agent's vectors, sets its new dimension, reports what it removed, and leaves other agents alone", async () => {
    const result = await resetEmbeddingSpace(asInstanceSlug(AGENT), asInstanceUuid(ids[AGENT]!), 1024);

    expect(result).toEqual({
      instanceId: ids[AGENT],
      memoriesDeleted: 2,
      knowledgeDocumentsDeleted: 1,
      knowledgeChunksDeleted: 2,
      newEmbeddingDim: 1024,
    });
    expect(await holdings(AGENT)).toEqual({ memories: 0, documents: 0, chunks: 0, dim: 1024 });
    expect(await holdings(OTHER)).toEqual({ memories: 2, documents: 1, chunks: 2, dim: 1536 });
  });

  it("writes the dimension it is given", async () => {
    await resetEmbeddingSpace(asInstanceSlug(AGENT), asInstanceUuid(ids[AGENT]!), 1536);

    expect((await holdings(AGENT))!.dim).toBe(1536);
  });
});
