// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The document list counts the whole agent, not the page it returns: the
 * panel's status checks read one row and still need to know how many
 * documents there are and how many failed to index.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveDatabaseAvailability } from "../../database/test-db.js";
import { queryClient } from "../../database/client.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { createDocument, updateDocumentStatus } from "../../knowledge/store.js";

vi.mock("./instance-helpers.js", () => ({ findInstanceOrFail: async (slug: string) => ({ slug }) }));

import { InstanceKnowledgeController } from "./instance-knowledge.controller.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const AGENT = asInstanceSlug(`itest-kcount-${Date.now()}`);
const OTHER = asInstanceSlug(`itest-kcount-other-${Date.now()}`);

async function seed(slug: typeof AGENT, filename: string, status: "ready" | "error"): Promise<void> {
  const doc = await createDocument({ instanceId: slug, filename, mimeType: "text/plain", sizeBytes: 1, rawContent: "x", contentHash: filename });
  await updateDocumentStatus(doc.id, status);
}

describe.skipIf(!DB_AVAILABLE)("GET /api/instances/:slug/knowledge counts (integration)", () => {
  const controller = new InstanceKnowledgeController();

  beforeAll(async () => {
    await seed(AGENT, "a.md", "ready");
    await seed(AGENT, "b.md", "error");
    await seed(AGENT, "c.md", "ready");
    await seed(AGENT, "d.md", "error");
    await seed(OTHER, "e.md", "error");
  });

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await queryClient`DELETE FROM knowledge_documents WHERE instance_id IN (${AGENT}, ${OTHER})`;
  });

  it("counts every document of the agent and the failed ones, whatever the page size", async () => {
    const page = await controller.list(AGENT, "1");

    expect(page.documents).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    expect(page.total).toBe(4);
    expect(page.failed).toBe(2);
  });

  it("counts zero for an agent without documents", async () => {
    const page = await controller.list(asInstanceSlug(`itest-kcount-none-${Date.now()}`), "1");

    expect(page).toMatchObject({ documents: [], nextOffset: null, total: 0, failed: 0 });
  });
});
