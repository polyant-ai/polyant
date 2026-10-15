// SPDX-License-Identifier: AGPL-3.0-or-later

import { runDirectTurn, persistDirectReply, postProcessDirectTurn, recordDirectTurnTrace } from "../agents/direct-turn.js";
import type { HookEventPayload } from "../hooks/hook-types.js";
import { ConversationStateBuffer } from "../conversations/state.buffer.js";
import { channelManager } from "../channels/channel-manager.js";
import { conversationStore } from "../conversations/index.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { listAndMarkPendingEventsProcessing, markEventsCompleted } from "../webhooks/webhook-backlog.store.js";
import { appendDailyLog } from "./activity-log.store.js";
import type { RoomConfig } from "./room.store.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import { setRoomConversationId } from "./room.store.js";
import { makeDelimiter, scrubClosing } from "../utils/untrusted-text.js";
import { roomLog } from "./room-logger.js";
import { projectEventPayload } from "./payload-projection.js";
import { eventDefinitions, eventSources } from "../webhooks/webhooks.schema.js";
import { db } from "../database/client.js";
import { eq, inArray } from "drizzle-orm";
import { randomBytes } from "crypto";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// The delimiters live in `utils/untrusted-text.ts` now. They were written here
// (see #84) and stayed private, so every later place that put somebody else's
// text into a prompt did it plainly — the webhook engine and <channel_identity>
// among them. Same functions, same behaviour, one importable home.

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
  // Source type per definition: it decides how the payload is rendered below.
  const sourceTypeByDefinition = new Map<string, string>();
  if (definitionIds.length > 0) {
    const defs = await db
      .select({
        id: eventDefinitions.id,
        name: eventDefinitions.name,
        interpretationPrompt: eventDefinitions.interpretationPrompt,
        sourceType: eventSources.sourceType,
      })
      .from(eventDefinitions)
      .innerJoin(eventSources, eq(eventDefinitions.eventSourceId, eventSources.id))
      .where(inArray(eventDefinitions.id, definitionIds));
    definitionPrompts = defs.map((d) => ({ name: d.name, interpretationPrompt: d.interpretationPrompt }));
    for (const d of defs) {
      if (d.sourceType) sourceTypeByDefinition.set(d.id, d.sourceType);
    }
  }

  // Render-time projection: the model sees the payload without the API URL
  // templates and node ids no interpretation prompt can act on. The raw payload
  // in `event_backlog` is untouched.
  const renderedPayloads = new Map<string, string>(
    pendingEvents.map((e) => [
      e.id,
      JSON.stringify(projectEventPayload(sourceTypeByDefinition.get(e.eventDefinitionId), e.rawPayload)),
    ]),
  );

  // Get conversation history
  const history = await conversationStore.getRecentMessages(conversationId, 50);

  // Build context usage estimate. `room.prompt` is counted here because it is
  // sent as a system section (see `roomPrompt` on the supervise() call below).
  const contextParts = [room.prompt, ...definitionPrompts.map((d) => d.interpretationPrompt)];
  const eventsText = pendingEvents.map((e) => renderedPayloads.get(e.id) ?? "").join("\n");
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
      const payloadJson = scrubClosing(renderedPayloads.get(evt.id) ?? "{}", payloadTag.close);
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

  // Room is supervise-direct, so its hook payload is wired here.
  const hookPayload: HookEventPayload = {
    instance: { slug: instanceSlug },
    conversation: { id: conversationId },
    channel: { type: room.outboundChannel ?? "room", id: room.outboundTarget ?? "" },
    user: { name: "room" },
    message: { text: messageToSupervise },
  };

  const outcome = await runDirectTurn({
    source: "room",
    instanceSlug,
    instanceConfig,
    conversationId,
    stateBuffer,
    hookPayload,
    log: roomLog,
    scope: "RoomCycle",
    supervisorExtras: {
      conversationHistory: history,
      // The Room mandate the operator edits in the panel. It used to reach
      // only the token estimate below, so a saved prompt looked delivered and
      // was not (#380).
      roomPrompt: room.prompt || undefined,
      includeHarness: new Set(["room"]),
    },
    onSuperviseError: async (err) => {
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
      const errTimestamp = errNow.toLocaleTimeString(instanceConfig.datetime.locale, { hour: "2-digit", minute: "2-digit", timeZone: instanceConfig.datetime.timezone });
      const errTriggers: string[] = [];
      if (pendingEvents.length > 0) errTriggers.push(`${pendingEvents.length} event(s)`);
      if (humanMessage) errTriggers.push("human message");
      const errContent = `———— ${errTimestamp} | ${errTriggers.join(" + ")} | ERROR ————\n${errorMsg.slice(0, 500)}`;
      await appendDailyLog(room.instanceId, errContent, pendingEvents.length)
        .catch((e) => roomLog.error("RoomCycle", "Failed to write error to activity log", e));
    },
  });
  if (!outcome) return;
  const { finalText, result, halted } = outcome;

  // On halt, deliver the canned reply to the room's outbound channel — room never
  // auto-sends (the agent uses room_send_message). Best-effort.
  if (halted && room.outboundChannel && room.outboundTarget) {
    try {
      await channelManager.sendOutbound(instanceSlug, room.outboundChannel, room.outboundTarget, finalText);
    } catch (err) {
      roomLog.error("RoomCycle", `halt send failed for ${instanceSlug}`, err);
    }
  }

  await persistDirectReply(conversationId, outcome);

  // Mark events as completed
  if (pendingEventIds.length > 0) {
    await markEventsCompleted(pendingEventIds, finalText.slice(0, 500), room.instanceId);
  }

  // Persist active conversationId so harness tools (e.g. compact_room_history) can find it
  await setRoomConversationId(room.instanceId, conversationId);

  postProcessDirectTurn({
    conversationId,
    instanceSlug,
    instanceConfig,
    titleContent: `Events: ${pendingEvents.length}${humanMessage ? ", Human message received" : ""}\nAssistant: ${finalText.slice(0, 300)}`,
    titleContext: "This is a Room event processing conversation.",
    log: roomLog,
  });

  const now = new Date();
  const timestamp = now.toLocaleTimeString(instanceConfig.datetime.locale, { hour: "2-digit", minute: "2-digit", timeZone: instanceConfig.datetime.timezone });
  const triggers: string[] = [];
  if (pendingEvents.length > 0) triggers.push(`${pendingEvents.length} event(s)`);
  if (humanMessage) triggers.push("human message");
  const logContent = `———— ${timestamp} | ${triggers.join(" + ")} ————\n${finalText.slice(0, 1000)}`;

  try {
    await appendDailyLog(room.instanceId, logContent, pendingEvents.length);
  } catch (err) {
    roomLog.error("RoomCycle", `Failed to write activity log for ${instanceSlug}`, err);
  }

  recordDirectTurnTrace({ conversationId, instanceSlug, channel: "room", contextPrepMs, cycleStart, result });
}
