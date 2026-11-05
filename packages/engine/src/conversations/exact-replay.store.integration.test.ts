// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Exact history replay against a real Postgres: what a turn stores comes back
 * serialized exactly as it was sent. A `jsonb` column would hand the tool input
 * back with its keys reordered (`jsonb` sorts them by length), and that request
 * would no longer share a prefix with the one the provider cached.
 *
 * Self-skips when no migrated database is reachable.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, afterAll } from "vitest";
import { conversationStore } from "./store.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { allTenantsScope } from "../authz/scope-filter.js";
import { buildExactHistory } from "./tool-history.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const CID = `itest:exact-replay:${Date.now()}`;
const SLUG = asInstanceSlug("itest-exact-replay");

const user = {
  role: "user",
  content: [
    { type: "text", text: "Quanto pago?" },
    { type: "text", text: "<context>\n<current_datetime>now</current_datetime>\n</context>" },
  ],
};
// Keys deliberately NOT in jsonb's order (shorter keys first).
const response = [
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "", providerOptions: { anthropic: { signature: "sig-1" } } },
      { type: "tool-call", toolCallId: "toolu_01", toolName: "kb_search", input: { searchQuery: "tariffe", k: 3 } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "toolu_01",
        toolName: "kb_search",
        output: { type: "json", value: { sectionTitle: "Tariffe", id: "doc-7" } },
      },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "29,90 euro." }] },
];

describe("exact replay storage (integration)", () => {
  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await conversationStore.deleteConversation(CID, allTenantsScope("integration test cleanup")).catch(() => {});
  });

  it.skipIf(!DB_AVAILABLE)("replays a stored turn byte for byte as it was sent", async () => {
    await conversationStore.ensureConversation(CID, SLUG);
    await conversationStore.appendMessages(CID, [
      { role: "user", content: "Quanto pago?", exactReplay: { messages: [user] }, createdAt: new Date(Date.UTC(2026, 10, 3, 10, 0, 0)) },
    ]);
    await conversationStore.appendMessages(CID, [
      { role: "assistant", content: "29,90 euro.", exactReplay: { messages: response, prefixKey: "key-A" } },
    ]);

    const rows = await conversationStore.getHistoryWindow(CID, { after: null, limit: 16, withSteps: true, withExactReplay: true });
    const history = buildExactHistory(rows, { keepReasoning: true });

    expect(JSON.stringify(history)).toBe(JSON.stringify([user, ...response]));
    expect(rows[1].exactReplay?.prefixKey).toBe("key-A");
  });
});
