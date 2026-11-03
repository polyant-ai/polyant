// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Indexing a document while another pass indexes it too. Two agent writes in a
 * row, or an upload while the agent writes, start two passes on one document;
 * the chunks they leave must be one complete set for the text the document
 * holds now, whatever order the passes finish in. The embedding provider is a
 * fake whose calls the tests release one at a time.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const embedding = vi.hoisted(() => {
  /** Calls wait on the gate of the first marker word they contain. */
  const gates = new Map<string, { promise: Promise<void>; open: () => void; fail: (e: Error) => void }>();
  const gate = (marker: string) => {
    let open!: () => void;
    let fail!: (e: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    gates.set(marker, { promise, open, fail });
    return gates.get(marker)!;
  };
  const embedMany = async (texts: string[]) => {
    const marker = [...gates.keys()].find((m) => texts.some((t) => t.includes(m)));
    if (marker) await gates.get(marker)!.promise;
    return texts.map((_, i) => Array.from({ length: 1024 }, (_, j) => (j === i % 1024 ? 1 : 0)));
  };
  return { gates, gate, embedMany };
});

vi.mock("../embeddings-gateway/index.js", () => ({
  embedMany: embedding.embedMany,
  resolveEmbeddingContext: async () => ({ dimensions: 1024, providerName: "openai" }),
}));

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { processDocument } from "./ingestion.js";
import { createDocument, getDocument, hashContent, upsertAgentDocument } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const AGENT = asInstanceSlug(`itest-ingest-${Date.now()}`);

/** About five chunks of one repeated word, so a mixed set is visible. */
const text = (word: string) => Array.from({ length: 900 }, (_, i) => `${word}${i % 10}`).join(" ");
const ALPHA = text("alpha");
const BRAVO = text("bravo");

async function newDocument(filename: string, content: string): Promise<string> {
  const doc = await createDocument({
    instanceId: AGENT,
    filename,
    mimeType: "text/markdown",
    sizeBytes: content.length,
    rawContent: content,
    contentHash: hashContent(content),
    source: "agent",
  });
  return doc.id;
}

async function chunkContents(docId: string): Promise<string[]> {
  const rows = await queryClient<{ content: string }[]>`
    SELECT content FROM knowledge_chunks WHERE document_id = ${docId} ORDER BY chunk_index`;
  return rows.map((r) => r.content);
}

/** Let a started pass run up to its gated embedding call. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeEach(() => {
  embedding.gates.clear();
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  await queryClient`DELETE FROM knowledge_documents WHERE instance_id = ${AGENT}`;
});

describe.skipIf(!DB_AVAILABLE)("processDocument with concurrent passes (integration)", () => {

  it("keeps only the chunks of the current text when an older pass finishes last", async () => {
    const docId = await newDocument("race.md", ALPHA);
    const alpha = embedding.gate("alpha");
    const older = processDocument(docId, AGENT, ALPHA);
    await settle();

    await upsertAgentDocument({ instanceId: AGENT, filename: "race.md", content: BRAVO });
    await processDocument(docId, AGENT, BRAVO);
    alpha.open();
    await older;

    const chunks = await chunkContents(docId);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.includes("bravo") && !c.includes("alpha"))).toBe(true);
    const doc = await getDocument(docId);
    expect(doc).toMatchObject({ status: "ready", chunkCount: chunks.length });
  });

  it("leaves one set of chunks when two passes index the same text", async () => {
    const docId = await newDocument("twice.md", ALPHA);
    const alpha = embedding.gate("alpha");
    const first = processDocument(docId, AGENT, ALPHA);
    const second = processDocument(docId, AGENT, ALPHA);
    await settle();
    alpha.open();
    await Promise.all([first, second]);

    const chunks = await chunkContents(docId);
    expect(new Set(chunks).size).toBe(chunks.length);
    expect((await getDocument(docId))?.chunkCount).toBe(chunks.length);
  });

  it("keeps the previous chunks searchable while the new text is embedded", async () => {
    const docId = await newDocument("live.md", ALPHA);
    await processDocument(docId, AGENT, ALPHA);
    const before = await chunkContents(docId);

    await upsertAgentDocument({ instanceId: AGENT, filename: "live.md", content: BRAVO });
    const bravo = embedding.gate("bravo");
    const pass = processDocument(docId, AGENT, BRAVO);
    await settle();

    expect(await chunkContents(docId)).toEqual(before);
    bravo.open();
    await pass;
    expect((await chunkContents(docId)).every((c) => c.includes("bravo"))).toBe(true);
  });

  it("does not mark the document failed when a superseded pass fails", async () => {
    const docId = await newDocument("fail.md", ALPHA);
    const alpha = embedding.gate("alpha");
    const older = processDocument(docId, AGENT, ALPHA);
    await settle();

    await upsertAgentDocument({ instanceId: AGENT, filename: "fail.md", content: BRAVO });
    await processDocument(docId, AGENT, BRAVO);
    alpha.fail(new Error("provider unavailable"));
    await older.catch(() => undefined);

    expect(await getDocument(docId)).toMatchObject({ status: "ready", errorMessage: null });
  });
});

describe.skipIf(!DB_AVAILABLE)("agent write of unchanged text (integration)", () => {
  it("asks for no reindex and leaves a ready document ready", async () => {
    const docId = await newDocument("same.md", ALPHA);
    await processDocument(docId, AGENT, ALPHA);

    const result = await upsertAgentDocument({ instanceId: AGENT, filename: "same.md", content: ALPHA });

    expect(result.reindex).toBe(false);
    expect((await getDocument(docId))?.status).toBe("ready");
  });

  it("asks for a reindex when the text changes", async () => {
    const docId = await newDocument("changed.md", ALPHA);
    await processDocument(docId, AGENT, ALPHA);

    const result = await upsertAgentDocument({ instanceId: AGENT, filename: "changed.md", content: BRAVO });

    expect(result.reindex).toBe(true);
    expect((await getDocument(docId))?.status).toBe("processing");
  });
});
