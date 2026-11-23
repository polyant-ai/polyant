// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The knowledge store's writes against a real Postgres: what an agent's
 * overwrite and append leave in the document row, what storing chunks leaves
 * in `knowledge_chunks`, and the score a vector search reports. Self-skips when
 * no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import {
  appendAgentDocument,
  DocumentSizeExceededError,
  hashContent,
  insertChunksAndFinalize,
  MAX_DOCUMENT_BYTES,
  searchByVector,
  upsertAgentDocument,
  type InsertChunkInput,
} from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-kstore";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

function axis(i: number, dims: 1024 | 1536): number[] {
  return Array.from({ length: dims }, (_, k) => (k === i ? 1 : 0));
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM knowledge_documents WHERE instance_id LIKE ${MARKER + "%"}`;
}

async function documentRow(filename: string) {
  const [row] = await queryClient<
    { id: string; raw_content: string; mime_type: string; size_bytes: number; status: string; chunk_count: number; source: string }[]
  >`
    SELECT id, raw_content, mime_type, size_bytes, status, chunk_count, source
    FROM knowledge_documents WHERE instance_id = ${AGENT} AND filename = ${filename}`;
  return row;
}

async function chunkRows(docId: string) {
  return queryClient<{ chunk_index: number; has1536: boolean; has1024: boolean; provider: string }[]>`
    SELECT chunk_index, embedding IS NOT NULL AS has1536, embedding_1024 IS NOT NULL AS has1024,
           embedding_provider AS provider
    FROM knowledge_chunks WHERE document_id = ${docId} ORDER BY chunk_index`;
}

/** An agent document whose stored text is `content`, ready to receive chunks. */
async function documentHolding(filename: string, content: string): Promise<string> {
  const { docId } = await upsertAgentDocument({ instanceId: AGENT, filename, content });
  return docId;
}

function chunks(docId: string, count: number, dims: 1024 | 1536): InsertChunkInput[] {
  return Array.from({ length: count }, (_, i) => ({
    documentId: docId,
    instanceId: AGENT,
    content: `chunk ${i}`,
    embedding: axis(i % 8, dims),
    chunkIndex: i,
  }));
}

describe.skipIf(!DB_AVAILABLE)("knowledge store writes (integration)", () => {
  beforeAll(teardown);
  afterAll(teardown);

  it("an agent overwrite creates the document once, then replaces its text and type in the same row", async () => {
    const first = await upsertAgentDocument({ instanceId: AGENT, filename: "notes.md", content: "hello" });
    expect(first).toMatchObject({ created: true, sizeBytes: 5, rawContent: "hello", reindex: true });
    expect(await documentRow("notes.md")).toMatchObject({
      id: first.docId, raw_content: "hello", mime_type: "text/markdown", source: "agent", status: "processing",
    });

    const second = await upsertAgentDocument({
      instanceId: AGENT, filename: "notes.md", content: "overwrite", mimeType: "text/plain",
    });

    expect(second).toMatchObject({ docId: first.docId, created: false, sizeBytes: 9, rawContent: "overwrite" });
    expect(await documentRow("notes.md")).toMatchObject({
      id: first.docId, raw_content: "overwrite", mime_type: "text/plain", size_bytes: 9,
    });
  });

  it("an append creates the document without a separator, then joins with a blank line", async () => {
    const first = await appendAgentDocument({ instanceId: AGENT, filename: "log.md", content: "A" });
    const second = await appendAgentDocument({ instanceId: AGENT, filename: "log.md", content: "B" });

    expect(first).toMatchObject({ created: true, rawContent: "A", sizeBytes: 1 });
    expect(second).toMatchObject({ docId: first.docId, created: false, rawContent: "A\n\nB", sizeBytes: 4 });
    expect(await documentRow("log.md")).toMatchObject({ raw_content: "A\n\nB", size_bytes: 4 });
  });

  it("refuses an append that would grow the document past the cap, leaving the text as it was", async () => {
    const existing = "x".repeat(MAX_DOCUMENT_BYTES - 10);
    await queryClient`
      INSERT INTO knowledge_documents (instance_id, filename, mime_type, size_bytes, raw_content, content_hash, source, status)
      VALUES (${AGENT}, 'big.md', 'text/markdown', ${existing.length}, ${existing}, ${hashContent(existing)}, 'agent', 'ready')`;

    await expect(
      appendAgentDocument({ instanceId: AGENT, filename: "big.md", content: "y".repeat(100) }),
    ).rejects.toBeInstanceOf(DocumentSizeExceededError);

    const row = await documentRow("big.md");
    expect(row!.size_bytes).toBe(existing.length);
    expect(row!.raw_content.endsWith("y")).toBe(false);
  });

  it("stores chunks in the column of their dimension, with the provider, and marks the document ready", async () => {
    const narrow = await documentHolding("narrow.md", "narrow text");
    const wide = await documentHolding("wide.md", "wide text");

    expect(await insertChunksAndFinalize(narrow, chunks(narrow, 2, 1024), 1024, "bedrock", hashContent("narrow text"))).toBe(2);
    expect(await insertChunksAndFinalize(wide, chunks(wide, 1, 1536), 1536, "openai", hashContent("wide text"))).toBe(1);

    expect(await chunkRows(narrow)).toEqual([
      { chunk_index: 0, has1536: false, has1024: true, provider: "bedrock" },
      { chunk_index: 1, has1536: false, has1024: true, provider: "bedrock" },
    ]);
    expect(await chunkRows(wide)).toEqual([{ chunk_index: 0, has1536: true, has1024: false, provider: "openai" }]);
    expect(await documentRow("narrow.md")).toMatchObject({ status: "ready", chunk_count: 2 });
  });

  it("replaces the previous chunk set, stores every chunk of a large document, and readies an empty one with zero", async () => {
    const docId = await documentHolding("large.md", "large text");
    await insertChunksAndFinalize(docId, chunks(docId, 3, 1024), 1024, "openai", hashContent("large text"));

    expect(await insertChunksAndFinalize(docId, chunks(docId, 1201, 1024), 1024, "openai", hashContent("large text"))).toBe(1201);
    const rows = await chunkRows(docId);
    expect(rows).toHaveLength(1201);
    expect(new Set(rows.map((r) => r.chunk_index)).size).toBe(1201);
    expect(await documentRow("large.md")).toMatchObject({ status: "ready", chunk_count: 1201 });

    expect(await insertChunksAndFinalize(docId, [], 1024, "openai", hashContent("large text"))).toBe(0);
    expect(await chunkRows(docId)).toEqual([]);
    expect(await documentRow("large.md")).toMatchObject({ status: "ready", chunk_count: 0 });
  });

  it("a vector search scores each chunk 1 - distance, rounded to four decimals, naming its document", async () => {
    const docId = await documentHolding("scored.md", "scored text");
    // cos(query, chunk) = 1/sqrt(3) = 0.57735…: the score is 0.5774.
    const tilted = Array.from({ length: 1024 }, (_, k) => (k < 3 ? 1 : 0));
    await insertChunksAndFinalize(
      docId,
      [{ documentId: docId, instanceId: AGENT, content: "tilted", embedding: tilted, chunkIndex: 0 }],
      1024,
      "openai",
      hashContent("scored text"),
    );

    const results = await searchByVector(axis(0, 1024), AGENT, 10, 1024);
    const scored = results.find((r) => r.content === "tilted");

    expect(scored).toMatchObject({ source: "scored.md", chunkIndex: 0, score: 0.5774 });
  });
});
