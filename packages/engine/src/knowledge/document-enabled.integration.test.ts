// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A knowledge document switched off stays stored but drops out of retrieval, by
 * vector and by keyword, and comes back when switched on. Self-skips without a database.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { createDocument, getKnowledgeForExport, listDocuments, searchByKeyword, searchByVector, setDocumentEnabled } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = asInstanceSlug(`itest-kdoc-${Date.now()}`);
const OTHER = asInstanceSlug(`itest-kdoc-other-${Date.now()}`);
const VECTOR = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

async function seed(slug: typeof SLUG, filename: string, text: string): Promise<string> {
  const doc = await createDocument({ instanceId: slug, filename, mimeType: "text/plain", sizeBytes: text.length, rawContent: text, contentHash: filename });
  await queryClient`
    INSERT INTO knowledge_chunks (document_id, instance_id, content, embedding_1024, chunk_index)
    VALUES (${doc.id}, ${slug}, ${text}, ${VECTOR}::vector, 0)`;
  return doc.id;
}

describe.skipIf(!DB_AVAILABLE)("knowledge document on/off (integration)", () => {
  let docId: string;
  let otherId: string;

  beforeAll(async () => {
    docId = await seed(SLUG, "guide.md", "zebrafish husbandry protocol");
    otherId = await seed(OTHER, "other.md", "zebrafish husbandry protocol");
  });

  afterAll(async () => {
    await queryClient`DELETE FROM knowledge_chunks WHERE instance_id LIKE 'itest-kdoc-%'`;
    await queryClient`DELETE FROM knowledge_documents WHERE instance_id LIKE 'itest-kdoc-%'`;
  });

  const sources = async () => ({
    vector: (await searchByVector(JSON.parse(VECTOR), SLUG, 10, 1024)).map((r) => r.source),
    keyword: (await searchByKeyword("zebrafish", SLUG, 10)).map((r) => r.source),
  });

  it("a new document is on and found by both backends", async () => {
    expect((await listDocuments(SLUG))[0]?.enabled).toBe(true);
    expect(await sources()).toEqual({ vector: ["guide.md"], keyword: ["guide.md"] });
  });

  it("a document switched off is still stored and listed but no longer found", async () => {
    expect(await setDocumentEnabled(docId, SLUG, false)).toBe(true);
    expect(await sources()).toEqual({ vector: [], keyword: [] });
    const [doc] = await listDocuments(SLUG);
    expect(doc).toMatchObject({ filename: "guide.md", enabled: false });
    expect((await getKnowledgeForExport(SLUG))[0]).toMatchObject({ filename: "guide.md", enabled: false });
  });

  it("switching it on again brings it back", async () => {
    expect(await setDocumentEnabled(docId, SLUG, true)).toBe(true);
    expect(await sources()).toEqual({ vector: ["guide.md"], keyword: ["guide.md"] });
  });

  it("will not switch another agent's document", async () => {
    expect(await setDocumentEnabled(otherId, SLUG, false)).toBe(false);
    expect((await searchByKeyword("zebrafish", OTHER, 10)).map((r) => r.source)).toEqual(["other.md"]);
  });

  it("creates a document switched off when asked, for an import that carried the flag", async () => {
    const doc = await createDocument({ instanceId: SLUG, filename: "off.md", mimeType: "text/plain", sizeBytes: 1, rawContent: "x", contentHash: "off", enabled: false });
    expect((await listDocuments(SLUG)).find((d) => d.id === doc.id)?.enabled).toBe(false);
  });
});
