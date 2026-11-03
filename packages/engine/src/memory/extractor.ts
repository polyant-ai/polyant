// SPDX-License-Identifier: AGPL-3.0-or-later

import { chat } from "../ai-gateway/index.js";
import type { ChatRequest } from "../ai-gateway/types.js";
import { conversationStore } from "../conversations/index.js";
import { embedMany, resolveEmbeddingContext } from "../embeddings-gateway/index.js";
import { upsertMemory } from "./memory-store.js";
import type { UpsertResult } from "./memory-store.js";
import type { ExtractedFact } from "./types.js";
import { createLogger, shouldLog } from "../utils/create-logger.js";
import { emitMemory } from "../activity-stream/emitters/emit-memory.js";
import { resolveInstanceMeta } from "../instances/instance-meta.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";

const memoryLog = createLogger();

/**
 * The extraction prompt, dated in the agent's timezone: the model turns
 * "tomorrow" into a date from it, so the date and its weekday must be the
 * agent's day, not the UTC date paired with the server's weekday.
 */
function buildExtractionPrompt(now: Date, timeZone: string): string {
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone, ...options });
  const ymd = part({ year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const field = (type: string) => ymd.find((p) => p.type === type)?.value;
  const dateStr = `${field("year")}-${field("month")}-${field("day")}`; // YYYY-MM-DD
  const dayName = part({ weekday: "long" }).format(now);

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
- Extract ONLY from the NEW MESSAGES; the EARLIER MESSAGES were already processed and are there only to make the new ones understandable
- If nothing worth extracting, return an empty array
- Respond ONLY with a JSON array, no markdown fences, no explanation

OUTPUT FORMAT (strict JSON array):
[{"content": "...", "category": "...", "importance": N}]`;
}

function renderTranscript(messages: readonly { role: string; content: string }[]): string {
  return messages
    .map((m) => {
      if (typeof m.content !== "string" || !m.content) return null;
      return `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Extract memories from the conversation messages not read yet, using the
 * project's LLM. Called in the background after every saved turn.
 */
export async function extractMemories(
  conversationId: string,
  instanceId: InstanceSlug,
  apiKeys?: ChatRequest["apiKeys"],
  provider?: string,
  langsmith?: { apiKey: string; project: string },
): Promise<UpsertResult[]> {
  const start = Date.now();

  // 1. The messages not read yet, with two before them for context: each
  //    message reaches the model once as new, instead of in every one of the
  //    next seven extractions.
  const { context, fresh, memoryThrough } = await conversationStore.getMessagesToExtract(conversationId, {
    limit: 15,
    context: 2,
  });
  const readUpTo = fresh.at(-1)?.createdAt;
  if (!readUpTo) return [];

  // 2. Build conversation transcript for the LLM
  const newText = renderTranscript(fresh);
  if (!newText.trim()) {
    await conversationStore.advanceMemoryThrough(conversationId, readUpTo, memoryThrough);
    return [];
  }
  const earlierText = renderTranscript(context);
  const transcript = [...(earlierText ? ["EARLIER MESSAGES:", earlierText, ""] : []), "NEW MESSAGES:", newText].join("\n");

  // From the 30s-cached config every turn already reads, not a fresh row read:
  // the agent's timezone dates the prompt, its threshold deduplicates the facts.
  const { datetime, dedupSimilarityThreshold } = await resolveInstanceConfig(instanceId);

  // 3. Call LLM for extraction (uses configured provider, tier fast)
  const response = await chat(
    {
      tier: "fast",
      provider,
      apiKeys,
      langsmith,
      system: buildExtractionPrompt(new Date(), datetime.timezone),
      messages: [{ role: "user", content: transcript }],
    },
    { conversationId, instanceId, callType: "service", purpose: "memory" },
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
    memoryLog.error("MemoryExtractor", `[${instanceId}] Failed to parse LLM extraction response (${response.text.length} chars)`);
    // The raw reply can echo conversation content: debug only, truncated.
    if (shouldLog("debug")) {
      memoryLog.debug("MemoryExtractor", `[${instanceId}] Unparseable extraction response: ${response.text.slice(0, 500)}`);
    }
    return [];
  }

  // The messages are read: the next extraction starts after them, whatever
  // happens to the facts below.
  await conversationStore.advanceMemoryThrough(conversationId, readUpTo, memoryThrough);

  if (facts.length === 0) return [];

  // 5. Generate embeddings for all extracted facts (batched)
  const contents = facts.map((f) => f.content);
  const ctx = await resolveEmbeddingContext(instanceId);
  const embeddings = await embedMany(contents, ctx);

  // 6. Upsert each memory sequentially (with deduplication via cosine similarity).
  //    Sequential — not Promise.all — to avoid SERIALIZABLE serialization_failure
  //    (40001) on the predicate scan inside `upsertMemory`. Two concurrent
  //    transactions reading the same `WHERE instance_id=$1` predicate range get
  //    flagged as a r/w pivot by Postgres and aborted; even with retries+jitter
  //    they re-collide. Sequential upsert costs ~10-30 ms more in a fire-and-forget
  //    path that doesn't block the user-facing response, in exchange for zero
  //    intra-batch conflicts. Cross-conversation conflicts on the same instance
  //    are still possible and handled by the retry loop in `upsertMemory`.
  // The threshold is resolved ONCE per extraction, not per fact: it is a
  // property of the agent, and the facts of one run all belong to the same one.

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
      dedupSimilarityThreshold,
      provider: ctx.providerName,
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