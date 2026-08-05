// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IncomingMessage } from "../channels/types.js";
import { isAutoTask } from "../pipeline.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { resolveInstanceId } from "../instances/resolve-instance-id.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { conversationStore } from "../conversations/index.js";
import { createAuditLogger } from "../audit/audit-logger.js";
import { evaluateOptout } from "./optout.guard.js";
import { getOptoutStatus, setOptoutStatus } from "./contact-optouts.store.js";

/** Synthetic channels never participate in opt-out (no real end-user contact). */
const OPTOUT_EXCLUDED_CHANNELS = new Set(["agent", "scheduled", "room"]);

export type OptoutGateResult = { proceed: true } | { proceed: false; reply: string };

/**
 * Deterministic pre-LLM opt-out gate. Runs at the very top of the message
 * handler, before Room/task routing and context prep, so STOP/START are always
 * honored first. Returns `{ proceed: true }` for the normal path, or a
 * short-circuit reply (possibly empty = no outbound) when the message is a
 * STOP/START transition or the contact is silenced.
 */
export async function runOptoutGate(msg: IncomingMessage): Promise<OptoutGateResult> {
  if (OPTOUT_EXCLUDED_CHANNELS.has(msg.channelType) || isAutoTask(msg.text)) {
    return { proceed: true };
  }

  const instanceSlug = msg.instanceId;
  const config = await resolveInstanceConfig(instanceSlug);
  if (!config.optout.enabled) return { proceed: true };

  const status = await getOptoutStatus(instanceSlug, msg.channelType, msg.channelId);
  const action = evaluateOptout({ config: config.optout, currentStatus: status, messageText: msg.text });

  if (action.kind === "pass") return { proceed: true };
  if (action.kind === "blocked_silent") return { proceed: false, reply: "" };

  // stop | resume — persist the transition, audit, and the conversation exchange.
  const newStatus = action.kind === "stop" ? "opted_out" : "opted_in";
  const instanceUuid = await resolveInstanceId(asInstanceSlug(instanceSlug));
  const audit = createAuditLogger(`optout:${action.kind}`, instanceSlug, undefined);
  const started = Date.now();
  try {
    if (instanceUuid) {
      await setOptoutStatus({
        instanceId: instanceUuid,
        instanceSlug,
        channelType: msg.channelType,
        channelId: msg.channelId,
        status: newStatus,
        source: "user",
      });
    }
    audit.log({
      action: `optout:${action.kind}`,
      success: true,
      durationMs: Date.now() - started,
      details: { channelType: msg.channelType, channelId: msg.channelId },
    });
  } catch (err) {
    audit.log({
      action: `optout:${action.kind}`,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      details: { channelType: msg.channelType, channelId: msg.channelId },
    });
  }

  await persistOptoutExchange(msg, action.reply ?? "");
  return { proceed: false, reply: action.reply ?? "" };
}

/**
 * Persist the STOP/START exchange (user keyword + confirmation) to the
 * conversation for admin visibility — lightweight: no memory/summary/trace/hooks.
 * Best-effort: a persistence failure never blocks honoring the opt-out.
 */
async function persistOptoutExchange(msg: IncomingMessage, reply: string): Promise<void> {
  const conversationId = `${msg.instanceId}:${msg.channelType}:${msg.channelId}`;
  try {
    await conversationStore.ensureConversation(conversationId, msg.instanceId, {
      channel: msg.channelType,
      userIdentifier: msg.userName,
      source: "user",
    });
    const messages: Array<{ role: string; content: string }> = [{ role: "user", content: msg.text }];
    if (reply) messages.push({ role: "assistant", content: reply });
    await conversationStore.appendMessages(conversationId, messages);
  } catch (err) {
    console.error(`[optout] failed to persist exchange for ${conversationId}:`, err instanceof Error ? err.message : String(err));
  }
}
