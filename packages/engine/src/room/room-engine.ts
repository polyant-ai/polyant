// SPDX-License-Identifier: AGPL-3.0-or-later

import { supervise } from "../agents/supervisor/index.js";
import { traceStore } from "../analytics/trace.store.js";
import { conversationStore } from "../conversations/index.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { extractMemories } from "../memory/extractor.js";
import { listAndMarkPendingEventsProcessing, markEventsCompleted } from "../webhooks/webhook-backlog.store.js";
import { appendDailyLog } from "./activity-log.store.js";
import type { RoomConfig } from "./room.store.js";
import { setRoomConversationId } from "./room.store.js";
import { generateConversationTitle } from "../utils/title-generator.js";
import { roomLog } from "./room-logger.js";
import { config } from "../config.js";
import { eventDefinitions } from "../webhooks/webhooks.schema.js";
import { db } from "../database/client.js";
import { inArray } from "drizzle-orm";
import { randomBytes } from "crypto";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build untrusted-data delimiters with a per-cycle random nonce so that an attacker
 * embedding `</webhook_payload>` (or similar) inside the payload cannot break out
 * of the boundary.  The closing tag is also scrubbed from the content as defence
 * in depth.  See #84.
 */
function makeDelimiter(tag: string, nonce: string): { open: string; close: string } {
  return { open: `<${tag}_${nonce}>`, close: `</${tag}_${nonce}>` };
}

function scrubClosing(input: string, close: string): string {
  return input.split(close).join("[CLOSING-TAG-REMOVED]");
}

export async function executeRoomCycle(
  room: RoomConfig,
  instanceSlug: string,
  humanMessage?: string,
): Promise<void> {
  const cycleStart = Date.now();
  const conversationId = `room:${room.instanceId}:${Date.now()}`;

  // Intentionally NOT calling emitConversation here: the room engine mints a
  // fresh conversationId per cycle (timestamp-suffixed), so every tick would
  // produce a "conversation: created" event and flood the panel. The room
  // cycle's activity is surfaced via the LLM tap (`chat()` replay batch in
  // bus-emitter.ts) plus the room's own `room_activity_log` table, so no
  // lifecycle event is needed here.
  const [instanceConfig, , pendingEvents] = await Promise.all([
    resolveInstanceConfig(instanceSlug),
    conversationStore.ensureConversation(conversationId, instanceSlug, {
      channel: "room",
      source: "room",
    }),
    listAndMarkPendingEventsProcessing(room.instanceId),
  ]);

  if (!humanMessage && pendingEvents.length === 0) {
    return;
  }

  // Gather interpretation prompts for the pending events' definitions
  const definitionIds = [...new Set(pendingEvents.map((e) => e.eventDefinitionId))];
  let definitionPrompts: Array<{ name: string; interpretationPrompt: string }> = [];
  if (definitionIds.length > 0) {
    const defs = await db
      .select({ name: eventDefinitions.name, interpretationPrompt: eventDefinitions.interpretationPrompt })
      .from(eventDefinitions)
      .where(inArray(eventDefinitions.id, definitionIds));
    definitionPrompts = defs;
  }

  // Get conversation history
  const history = await conversationStore.getRecentMessages(conversationId, 50);

  // Build context usage estimate
  const contextParts = [room.prompt, ...definitionPrompts.map((d) => d.interpretationPrompt)];
  const eventsText = pendingEvents.map((e) => JSON.stringify(e.rawPayload)).join("\n");
  const historyText = history.map((m) => String(m.content)).join("\n");
  const totalEstimate = estimateTokens([...contextParts, eventsText, historyText].join("\n"));
  const maxTokens = 128_000;

  // Build the synthetic message
  const parts: string[] = [];

  // Per-cycle nonce prevents delimiter spoofing — an attacker cannot forge the
  // closing tag because they cannot guess the random suffix.  See #84.
  const msgNonce = randomBytes(8).toString("hex");
  const payloadTag = makeDelimiter("webhook_payload", msgNonce);
  const humanTag = makeDelimiter("human_message", msgNonce);

  parts.push(`[Room context usage: ~${totalEstimate.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${Math.round((totalEstimate / maxTokens) * 100)}%)]`);
  parts.push("");

  if (pendingEvents.length > 0) {
    parts.push(`## Pending Events (${pendingEvents.length})`);
    for (const evt of pendingEvents) {
      parts.push(`- Event ID: ${evt.id}`);
      const payloadJson = scrubClosing(JSON.stringify(evt.rawPayload), payloadTag.close);
      parts.push(`  Payload: ${payloadTag.open}${payloadJson}${payloadTag.close}`);
      parts.push(`  Received: ${evt.matchedAt?.toISOString() ?? evt.createdAt?.toISOString()}`);
    }
    parts.push("");
  }

  if (definitionPrompts.length > 0) {
    parts.push("## Event Handling Instructions");
    for (const def of definitionPrompts) {
      parts.push(`### ${def.name}`);
      parts.push(def.interpretationPrompt);
      parts.push("");
    }
  }

  if (humanMessage) {
    parts.push("## Human Message");
    const sanitizedHuman = scrubClosing(humanMessage, humanTag.close);
    parts.push(`${humanTag.open}${sanitizedHuman}${humanTag.close}`);
    parts.push("");
  }

  const syntheticMessage = parts.join("\n");

  const contextPrepMs = Date.now() - cycleStart;

  const messageToSupervise = syntheticMessage;

  // Persist the synthetic user message so conversation history has proper role alternation
  await conversationStore.appendMessages(conversationId, [
    { role: "user", content: messageToSupervise },
  ]);

  const pendingEventIds = pendingEvents.map((e) => e.id);

  let result;
  try {
    result = await supervise({
      message: messageToSupervise,
      conversationHistory: history,
      instanceId: instanceSlug,
      conversationId,
      provider: instanceConfig.provider,
      model: instanceConfig.model,
      apiKeys: instanceConfig.apiKeys,
      secrets: instanceConfig.secrets,
      memoryEnabled: instanceConfig.memoryEnabled,
      thinkingEnabled: instanceConfig.thinkingEnabled,
      includeHarness: new Set(["room"]),
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    roomLog.error("RoomCycle", `supervise() failed for ${instanceSlug}`, err);

    // Mark events as completed with error so they don't stay stuck in "processing"
    if (pendingEventIds.length > 0) {
      await markEventsCompleted(pendingEventIds, `ERROR: ${errorMsg.slice(0, 400)}`, room.instanceId).catch((e) =>
        roomLog.error("RoomCycle", "Failed to mark events completed after error", e),
      );
    }

    // Write error to activity log so it's visible in the admin panel
    const errNow = new Date();
    const errTimestamp = errNow.toLocaleTimeString(config.datetime.locale, { hour: "2-digit", minute: "2-digit", timeZone: config.datetime.timezone });
    const errTriggers: string[] = [];
    if (pendingEvents.length > 0) errTriggers.push(`${pendingEvents.length} event(s)`);
    if (humanMessage) errTriggers.push("human message");
    const errContent = `———— ${errTimestamp} | ${errTriggers.join(" + ")} | ERROR ————\n${errorMsg.slice(0, 500)}`;
    await appendDailyLog(room.instanceId, errContent, pendingEvents.length)
      .catch((e) => roomLog.error("RoomCycle", "Failed to write error to activity log", e));

    return;
  }

  const finalText = result.text;

  await conversationStore.appendMessages(conversationId, [
    { role: "assistant", content: finalText, steps: result.steps, ...(result.reasoning ? { reasoning: result.reasoning } : {}) },
  ]);

  // Mark events as completed
  if (pendingEventIds.length > 0) {
    await markEventsCompleted(pendingEventIds, finalText.slice(0, 500), room.instanceId);
  }

  // Persist active conversationId so harness tools (e.g. compact_room_history) can find it
  await setRoomConversationId(room.instanceId, conversationId);

  // Fire-and-forget post-processing
  const postProcess = async () => {
    await generateConversationTitle({
      conversationId,
      instanceId: instanceSlug,
      provider: instanceConfig.provider,
      apiKeys: instanceConfig.apiKeys,
      content: `Events: ${pendingEvents.length}${humanMessage ? ", Human message received" : ""}\nAssistant: ${finalText.slice(0, 300)}`,
      context: "This is a Room event processing conversation.",
    });

    if (instanceConfig.memoryEnabled !== false) {
      extractMemories(conversationId, instanceSlug, instanceConfig.apiKeys, instanceConfig.provider).catch((err) =>
        roomLog.error("PostProcess", "Memory extraction failed", err),
      );
    }
  };
  postProcess().catch((err) => roomLog.error("PostProcess", "post-processing error", err));

  const now = new Date();
  const timestamp = now.toLocaleTimeString(config.datetime.locale, { hour: "2-digit", minute: "2-digit", timeZone: config.datetime.timezone });
  const triggers: string[] = [];
  if (pendingEvents.length > 0) triggers.push(`${pendingEvents.length} event(s)`);
  if (humanMessage) triggers.push("human message");
  const logContent = `———— ${timestamp} | ${triggers.join(" + ")} ————\n${finalText.slice(0, 1000)}`;

  try {
    await appendDailyLog(room.instanceId, logContent, pendingEvents.length);
  } catch (err) {
    roomLog.error("RoomCycle", `Failed to write activity log for ${instanceSlug}`, err);
  }

  traceStore.record({
    conversationId,
    instanceId: instanceSlug,
    channel: "room",
    contextPrepMs,
    toolBuildingMs: result.toolBuildingMs,
    llmCallMs: result.durationMs,
    totalMs: Date.now() - cycleStart,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    toolCalls: result.toolCallTraces,
    isStreaming: false,
  });
}
