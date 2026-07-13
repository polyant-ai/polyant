// SPDX-License-Identifier: AGPL-3.0-or-later

import { supervise, type SupervisorOutput } from "../agents/supervisor/index.js";
import { runHooks, firstHalt, firstReplaceResponse, hookProvenance } from "../hooks/hook-runner.js";
import type { HookEventPayload, HookRunContext } from "../hooks/hook-types.js";
import { ConversationStateBuffer } from "../conversations/state.buffer.js";
import { channelManager } from "../channels/channel-manager.js";
import { traceStore } from "../analytics/trace.store.js";
import { conversationStore } from "../conversations/index.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { extractMemories } from "../memory/extractor.js";
import { listAndMarkPendingEventsProcessing, markEventsCompleted } from "../webhooks/webhook-backlog.store.js";
import { appendDailyLog } from "./activity-log.store.js";
import type { RoomConfig } from "./room.store.js";
import { type InstanceSlug } from "../instances/identifiers.js";
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
  instanceSlug: InstanceSlug,
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

  // Conversation state buffer (commit-on-success), mirroring the inbound + webhook
  // pipelines: room tools and hook functions share one buffer via `ctx.state`;
  // writes persist only after supervise succeeds (flushed below).
  const stateBuffer = await ConversationStateBuffer.load(conversationId, instanceSlug).catch((err) => {
    roomLog.error("RoomCycle", `failed to load conversation state for ${conversationId}`, err);
    return new ConversationStateBuffer(conversationId, instanceSlug);
  });

  // Hook context shared by the pre-LLM (message_received) and post-LLM
  // (response_generated) runs. Room is supervise-direct, so wire it manually.
  const hookPayload: HookEventPayload = {
    instance: { slug: instanceSlug },
    conversation: { id: conversationId },
    channel: { type: room.outboundChannel ?? "room", id: room.outboundTarget ?? "" },
    user: { name: "room" },
    message: { text: messageToSupervise },
  };
  const hookCtx: HookRunContext = {
    instanceId: instanceSlug,
    conversationId,
    secrets: instanceConfig.secrets,
    apiKeys: instanceConfig.apiKeys,
    provider: instanceConfig.provider,
    model: instanceConfig.model,
    flags: {
      memory: instanceConfig.memoryEnabled,
      knowledge: instanceConfig.knowledgeEnabled,
      thinking: instanceConfig.thinkingEnabled,
      debug: instanceConfig.debugEnabled,
      stateInPrompt: instanceConfig.stateInPromptEnabled,
      toolResultsInHistory: instanceConfig.toolResultsInHistoryEnabled,
    },
    state: stateBuffer.api(),
  };
  // Pre-LLM hook (halt-capable). Only message_received fires here (see the
  // halt-and-respond spec §6). Keep the summaries for provenance on halt.
  const preHookSummaries = await runHooks("message_received", hookPayload, hookCtx);
  const halt = firstHalt(preHookSummaries);

  let result: SupervisorOutput | undefined;
  if (!halt) {
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
        debugEnabled: instanceConfig.debugEnabled,
        datetimeInjectionEnabled: instanceConfig.datetimeInjectionEnabled,
        cacheConfig: instanceConfig.cacheConfig,
        includeHarness: new Set(["room"]),
        stateBuffer,
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
  }

  // Post-LLM hook (response-replacement capable). Room has no streaming, so a
  // replace always applies. Only runs in the non-halt path (result is defined).
  // response_generated hooks can also write state, so run before the flush below.
  let replace: ReturnType<typeof firstReplaceResponse>;
  let postHooks = preHookSummaries; // default to pre-summaries so provenance covers the halt case
  if (!halt) {
    postHooks = await runHooks(
      "response_generated",
      { ...hookPayload, response: { text: result!.text } },
      hookCtx,
    );
    replace = firstReplaceResponse(postHooks);
  }

  const finalText = halt ? halt.message : replace ? replace.message : result!.text;
  // Provenance: the pre-LLM halt or the post-LLM replace that authored the reply.
  const provenance = halt ? hookProvenance(preHookSummaries) : hookProvenance(postHooks);

  // Commit conversation state (commit-on-success): reached only after supervise
  // succeeded (the catch above returns) and the response_generated hooks ran.
  // Errors logged, not propagated.
  try {
    await stateBuffer.flush();
  } catch (err) {
    roomLog.error("RoomCycle", `failed to flush conversation state for ${conversationId}`, err);
  }

  // On halt, deliver the canned reply to the room's outbound channel — room never
  // auto-sends (the agent uses room_send_message). Best-effort.
  if (halt && room.outboundChannel && room.outboundTarget) {
    try {
      await channelManager.sendOutbound(instanceSlug, room.outboundChannel, room.outboundTarget, finalText);
    } catch (err) {
      roomLog.error("RoomCycle", `halt send failed for ${instanceSlug}`, err);
    }
  }

  await conversationStore.appendMessages(conversationId, [
    { role: "assistant", content: finalText, steps: result?.steps, ...(result?.reasoning ? { reasoning: result.reasoning } : {}), ...(result?.debugPayload ? { debugPayload: result.debugPayload } : {}), ...(provenance ? { metadata: provenance } : {}) },
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
    toolBuildingMs: result?.toolBuildingMs ?? 0,
    llmCallMs: result?.durationMs ?? 0,
    totalMs: Date.now() - cycleStart,
    promptTokens: result?.usage?.promptTokens ?? 0,
    completionTokens: result?.usage?.completionTokens ?? 0,
    toolCalls: result?.toolCallTraces,
    isStreaming: false,
  });
}
