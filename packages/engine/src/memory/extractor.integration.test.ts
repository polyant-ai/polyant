// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Memory extraction runs after every turn. It used to send the last fifteen
 * messages each time, so every message was extracted seven or eight times and
 * its facts embedded and deduplicated again. It now reads what it has not read
 * yet, with two earlier messages for context, and skips the model call when
 * there is nothing new. Real database; the extraction model is replaced.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const extraction = vi.hoisted(() => ({ transcripts: [] as string[] }));

vi.mock("../ai-gateway/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-gateway/index.js")>();
  return {
    ...actual,
    chat: async (request: { messages: Array<{ content: string }> }) => {
      extraction.transcripts.push(request.messages[0].content);
      return { text: "[]" };
    },
  };
});

import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { conversationStore } from "../conversations/index.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { extractMemories } from "./extractor.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-memory-extract";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("memory extraction reads each message once (integration)", () => {
  beforeAll(teardown);
  afterAll(teardown);
  beforeEach(() => {
    extraction.transcripts.length = 0;
  });

  it("sends only the messages it has not read, with two before them, and nothing when none are new", async () => {
    const conversationId = `${MARKER}-${randomUUID()}`;
    await conversationStore.ensureConversation(conversationId, AGENT, { channel: "web" });
    const t0 = Date.now() - 60_000;
    const exchange = (n: number) =>
      conversationStore.appendMessages(conversationId, [
        { role: "user", content: `question ${n}`, createdAt: new Date(t0 + n * 1_000) },
        { role: "assistant", content: `answer ${n}`, createdAt: new Date(t0 + n * 1_000 + 500) },
      ]);

    await exchange(1);
    await exchange(2);
    await extractMemories(conversationId, AGENT);
    await exchange(3);
    await extractMemories(conversationId, AGENT);
    await extractMemories(conversationId, AGENT);

    expect(extraction.transcripts).toHaveLength(2);
    const [, second] = extraction.transcripts;
    const [earlier, fresh] = second.split("NEW MESSAGES:");
    expect(fresh).toContain("question 3");
    expect(fresh).toContain("answer 3");
    expect(fresh).not.toContain("question 2");
    expect(earlier).toContain("question 2");
    expect(second).not.toContain("question 1");
  });
});
