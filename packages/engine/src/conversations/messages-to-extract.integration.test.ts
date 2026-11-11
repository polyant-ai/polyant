// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What memory extraction reads next, against a real Postgres: everything until the
 * first mark, then only what was saved after the mark it advanced.
 *
 * Self-skips when no migrated database is reachable.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, afterAll } from "vitest";
import { conversationStore } from "./store.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { allTenantsScope } from "../authz/scope-filter.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const CID = `itest:extract:${Date.now()}`;
const SLUG = asInstanceSlug("itest-extract");
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s));

describe("messages to extract (integration)", () => {
  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await conversationStore.deleteConversation(CID, allTenantsScope("integration test cleanup")).catch(() => {});
  });

  it.skipIf(!DB_AVAILABLE)("reads every message before the first mark, then only the ones saved after it", async () => {
    await conversationStore.ensureConversation(CID, SLUG);
    // Distinct times: the read orders by created_at, and rows saved in one statement share one.
    await conversationStore.appendMessages(CID, [
      { role: "user", content: "first question", createdAt: at(0) },
      { role: "assistant", content: "first answer", createdAt: at(1) },
    ]);

    const first = await conversationStore.getMessagesToExtract(CID, { limit: 10, context: 2 });
    expect(first.memoryThrough).toBeNull();
    expect(first.fresh.map((m) => m.content)).toEqual(["first question", "first answer"]);
    expect(first.through).not.toBeNull();

    await conversationStore.advanceMemoryThrough(CID, first.through!, first.memoryThrough);
    await conversationStore.appendMessages(CID, [
      { role: "user", content: "second question", createdAt: at(2) },
      { role: "assistant", content: "second answer", createdAt: at(3) },
    ]);

    const second = await conversationStore.getMessagesToExtract(CID, { limit: 10, context: 2 });
    expect(second.memoryThrough).toBe(first.through);
    expect(second.fresh.map((m) => m.content)).toEqual(["second question", "second answer"]);
    expect(second.context.map((m) => m.content)).toEqual(["first question", "first answer"]);
  });
});
