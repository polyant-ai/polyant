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

const extraction = vi.hoisted(() => ({
  transcripts: [] as string[],
  /** Extract one fact per new user message, instead of none. */
  factPerUserMessage: false,
  /** How many of the next embedding requests fail, as a provider that is down does. */
  embeddingFailures: 0,
}));

vi.mock("../ai-gateway/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-gateway/index.js")>();
  return {
    ...actual,
    chat: async (request: { messages: Array<{ content: string }> }) => {
      const transcript = request.messages[0].content;
      extraction.transcripts.push(transcript);
      if (!extraction.factPerUserMessage) return { text: "[]" };
      const fresh = transcript.split("NEW MESSAGES:")[1] ?? "";
      const facts = fresh
        .split("\n")
        .filter((line) => line.startsWith("User: "))
        .map((line) => ({ content: `The user said: ${line.slice("User: ".length)}`, category: "fact", importance: 8 }));
      return { text: JSON.stringify(facts) };
    },
  };
});

// The embedding provider is the external boundary: a distinct unit vector per fact.
vi.mock("../embeddings-gateway/index.js", () => ({
  resolveEmbeddingContext: async () => ({ dimensions: 1024, providerName: "openai", credentials: { provider: "openai", apiKey: "test" } }),
  embedMany: async (texts: string[]) => {
    if (extraction.embeddingFailures > 0) {
      extraction.embeddingFailures -= 1;
      throw Object.assign(new Error("rate limited"), { statusCode: 429 });
    }
    return texts.map((_, i) => Array.from({ length: 1024 }, (__, d) => (d === (vectorSeed + i) % 1024 ? 1 : 0)));
  },
}));
let vectorSeed = 0;

import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { conversationStore } from "../conversations/index.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { extractMemories } from "./extractor.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-memory-extract";
const AGENT = asInstanceSlug(`${MARKER}-agent`);

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM memories WHERE instance_id = ${AGENT}`;
  await queryClient`DELETE FROM conversation_messages WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM conversations WHERE conversation_id LIKE ${MARKER + "%"}`;
}

async function memoriesOf(conversationId: string): Promise<string[]> {
  const rows = await queryClient<{ content: string }[]>`
    SELECT content FROM memories WHERE source_conversation_id = ${conversationId} ORDER BY content`;
  return rows.map((r) => r.content);
}

describe.skipIf(!DB_AVAILABLE)("memory extraction reads each message once (integration)", () => {
  beforeAll(teardown);
  afterAll(teardown);
  beforeEach(() => {
    extraction.transcripts.length = 0;
    extraction.factPerUserMessage = false;
    extraction.embeddingFailures = 0;
    vectorSeed += 16;
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

  it("reads the same messages again when the facts could not be embedded", async () => {
    extraction.factPerUserMessage = true;
    const conversationId = `${MARKER}-${randomUUID()}`;
    await conversationStore.ensureConversation(conversationId, AGENT, { channel: "web" });
    await conversationStore.appendMessages(conversationId, [
      { role: "user", content: "my plate is AB123CD" },
      { role: "assistant", content: "noted" },
    ]);

    extraction.embeddingFailures = 1;
    await expect(extractMemories(conversationId, AGENT)).rejects.toThrow("rate limited");
    await extractMemories(conversationId, AGENT);

    expect(extraction.transcripts).toHaveLength(2);
    expect(extraction.transcripts[1].split("NEW MESSAGES:")[1]).toContain("my plate is AB123CD");
    expect(await memoriesOf(conversationId)).toEqual(["The user said: my plate is AB123CD"]);
  });
});
