// SPDX-License-Identifier: AGPL-3.0-or-later

import { chat } from "../ai-gateway/index.js";
import type { ChatRequest } from "../ai-gateway/types.js";
import { conversationStore } from "../conversations/index.js";
import { embedMany, resolveEmbeddingContext } from "../embeddings-gateway/index.js";
import { upsertMemory } from "./memory-store.js";
import type { UpsertResult } from "./memory-store.js";
import type { ExtractedFact } from "./types.js";
import { memoryLog } from "./memory-logger.js";
import { emitMemory } from "../activity-stream/emitters/emit-memory.js";
import { resolveInstanceMeta } from "../activity-stream/emit-helpers.js";
import { type InstanceSlug } from "../instances/identifiers.js";

function buildExtractionPrompt(): string {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = dayNames[now.getDay()];

  return `You are a memory extraction system. Your task is to extract important facts, preferences, decisions, and events from a conversation.

TODAY'S DATE: ${dateStr} (${dayName})

RULES:
- Extract ONLY concrete, factual information worth remembering long-term
- Each fact must be a standalone sentence (understandable without context)
- Write facts from a third-person perspective about "the user"
- CRITICAL: Always convert relative dates to absolute dates. "tomorrow" → "${dateStr}" + 1 day, "today" → "${dateStr}", "next Monday" → the actual date, etc. Every temporal reference must include the concrete date (e.g. "The user has a meeting on 2026-02-23 at 10:00")
- Write each fact in the SAME LANGUAGE as the conversation (if the user speaks Italian, write in Italian; if English, write in English)
- Categorize each fact: preference, fact, event, relationship, decision, general
- Rate importance 1-10 (10 = critical life fact, 1 = trivial)
- Do NOT extract: greetings, filler, questions without answers, assistant responses
- Do NOT extract facts that are purely about the current task/request being performed
- If nothing worth extracting, return an empty array
- Respond ONLY with a JSON array, no markdown fences, no explanation

OUTPUT FORMAT (strict JSON array):
[{"content": "...", "category": "...", "importance": N}]`;
}

/**
 * Extract memories from recent conversation messages using the project's LLM.
 * Designed to be called fire-and-forget after every supervisor response.
 */
export async function extractMemories(
  conversationId: string,
  instanceId: InstanceSlug,
  apiKeys?: ChatRequest["apiKeys"],
  provider?: string,
  langsmith?: { apiKey: string; project: string },
): Promise<UpsertResult[]> {
  const start = Date.now();

  // 1. Load the last 15 messages
  const recentMessages = await conversationStore.getRecentMessages(conversationId, 15);

  if (recentMessages.length === 0) return [];

  // 2. Build conversation transcript for the LLM
  const transcript = recentMessages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) return null;
      const role = m.role === "user" ? "User" : "Assistant";
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join("\n");

  if (!transcript.trim()) return [];

  // 3. Call LLM for extraction (uses configured provider, tier fast)
  const response = await chat(
    {
      tier: "fast",
      provider,
      apiKeys,
      langsmith,
      system: buildExtractionPrompt(),
      messages: [{ role: "user", content: transcript }],
    },
    { conversationId, instanceId, callType: "service" },
  );

  // 4. Parse JSON response
  let facts: ExtractedFact[];
  try {
    const cleaned = response.text.trim().replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    facts = JSON.parse(cleaned);
    if (!Array.isArray(facts)) {
      memoryLog.error("MemoryExtractor", `[${instanceId}] LLM returned non-array response`);
      return [];
    }
  } catch {
    memoryLog.error("MemoryExtractor", `[${instanceId}] Failed to parse LLM extraction response: ${response.text}`);
    return [];
  }

  if (facts.length === 0) return [];

  // 5. Generate embeddings for all extracted facts (batched)
  const contents = facts.map((f) => f.content);
  const ctx = await resolveEmbeddingContext(instanceId);
  const embeddings = await embedMany(contents, ctx);

  // 6. Upsert each memory sequentially (with deduplication via cosine similarity).
  //    Sequential — not Promise.all — to avoid SERIALIZABLE serialization_failure
  //    (40001) on the predicate scan inside `upsertMemory`. Two concurrent
  //    transactions reading the same `WHERE agent_id=$1` predicate range get
  //    flagged as a r/w pivot by Postgres and aborted; even with retries+jitter
  //    they re-collide. Sequential upsert costs ~10-30 ms more in a fire-and-forget
  //    path that doesn't block the user-facing response, in exchange for zero
  //    intra-batch conflicts. Cross-conversation conflicts on the same instance
  //    are still possible and handled by the retry loop in `upsertMemory`.
  const results: UpsertResult[] = [];
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const result = await upsertMemory({
      instanceId,
      content: fact.content,
      category: fact.category,
      importance: fact.importance,
      sourceConversationId: conversationId,
      embedding: embeddings[i],
      dimensions: ctx.dimensions,
      provider: ctx.credentials.provider,
    });
    results.push(result);
  }

  const elapsed = Date.now() - start;
  const added = results.filter((r) => r.event === "ADD").length;
  const updated = results.filter((r) => r.event === "UPDATE").length;
  memoryLog.info("MemoryExtractor", `[${instanceId}] ${results.length} fact(s) in ${elapsed}ms — added=${added} updated=${updated}`);

  // Activity-stream emit: one event per batch (never per-fact — would flood the panel).
  // Fire-and-forget; the emitter is safeEmit-wrapped so failures never bubble.
  if (results.length > 0) {
    resolveInstanceMeta(instanceId)
      .then((instance) => {
        emitMemory({
          count: results.length,
          categories: facts.map((f) => f.category),
          firstMemoryText: facts[0]?.content,
          conversationId,
          instance,
        });
      })
      .catch(() => {
        // resolveInstanceMeta already swallows errors, but guard the promise chain.
      });
  }

  return results;
}