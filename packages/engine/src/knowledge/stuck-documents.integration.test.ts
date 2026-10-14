// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A document whose ingestion died with its process must not read as "still
 * working" for ever: nobody re-uploads a document that looks busy. These run
 * the recovery against a real Postgres.
 *
 * Self-skips when no migrated database is reachable.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { knowledgeDocuments } from "./schema.js";
import { resetStuckProcessingAll, touchDocument } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const AGENT = "itest-stuck-docs";

async function insertDoc(filename: string, status: "uploading" | "processing", minutesAgo: number): Promise<string> {
  const [row] = await db
    .insert(knowledgeDocuments)
    .values({ instanceId: AGENT, filename, mimeType: "text/plain", status, rawContent: "x" })
    .returning({ id: knowledgeDocuments.id });
  await db
    .update(knowledgeDocuments)
    .set({ updatedAt: sql`now() - make_interval(mins => ${minutesAgo})` })
    .where(eq(knowledgeDocuments.id, row!.id));
  return row!.id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await db.select({ status: knowledgeDocuments.status }).from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
  return row?.status;
}

beforeEach(async () => {
  if (!DB_AVAILABLE) return;
  await db.delete(knowledgeDocuments).where(like(knowledgeDocuments.instanceId, AGENT));
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  await db.delete(knowledgeDocuments).where(like(knowledgeDocuments.instanceId, AGENT));
});

describe("resetStuckProcessingAll (integration)", () => {
  it.skipIf(!DB_AVAILABLE)("fails a document left uploading or processing with no progress", async () => {
    const uploading = await insertDoc("a.txt", "uploading", 10);
    const processing = await insertDoc("b.txt", "processing", 10);

    await resetStuckProcessingAll();

    expect(await statusOf(uploading)).toBe("error");
    expect(await statusOf(processing)).toBe("error");
  });

  it.skipIf(!DB_AVAILABLE)("leaves alone a document whose ingestion still reports progress", async () => {
    const live = await insertDoc("c.txt", "processing", 10);
    await touchDocument(live);

    await resetStuckProcessingAll();

    expect(await statusOf(live)).toBe("processing");
  });
});
