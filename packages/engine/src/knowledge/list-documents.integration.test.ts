// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An agent's document list is read a page at a time: the panel polls it while
 * documents are processing, and an agent can hold as many documents as its
 * organization is entitled to.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { createDocument, listDocuments } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const AGENT = asInstanceSlug(`itest-listdocs-${Date.now()}`);
const FILENAMES = ["a.md", "b.md", "c.md", "d.md", "e.md"];

describe.skipIf(!DB_AVAILABLE)("listDocuments (integration)", () => {
  beforeAll(async () => {
    for (const filename of FILENAMES) {
      await createDocument({ instanceId: AGENT, filename, mimeType: "text/markdown", sizeBytes: 1, rawContent: "x", contentHash: filename });
    }
  });

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await queryClient`DELETE FROM knowledge_documents WHERE instance_id = ${AGENT}`;
  });

  it("returns at most the page asked for, and where the next one starts", async () => {
    const page = await listDocuments(AGENT, { limit: 2, offset: 0 });

    expect(page.documents).toHaveLength(2);
    expect(page.nextOffset).toBe(2);
  });

  it("walks every document once across pages, newest first", async () => {
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await listDocuments(AGENT, { limit: 2, offset });
      seen.push(...page.documents.map((d) => d.filename));
      offset = page.nextOffset;
    }

    expect(seen).toEqual([...FILENAMES].reverse());
  });
});
