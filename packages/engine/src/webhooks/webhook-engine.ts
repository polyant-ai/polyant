// SPDX-License-Identifier: AGPL-3.0-or-later

import { supervise } from "../agents/supervisor/index.js";
import { traceStore } from "../analytics/trace.store.js";
import { conversationStore } from "../conversations/index.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { extractMemories } from "../memory/extractor.js";
import { generateConversationTitle } from "../utils/title-generator.js";
import { channelManager } from "../channels/channel-manager.js";
import { renderTemplate } from "./template-renderer.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import { registerTrigger } from "./active-triggers.js";
import { setTriggerContext, clearTriggerContext } from "./trigger-context.js";
import { webhookLog } from "./webhook-logger.js";
import type { EventDefinition } from "./webhook-sources.store.js";
import { emitConversation } from "../activity-stream/emitters/emit-conversation.js";
import { resolveInstanceMeta } from "../activity-stream/emit-helpers.js";
import { ConversationStateBuffer } from "../conversations/state.buffer.js";

/**
 * Trigger an immediate conversation from a matched webhook event.
 *
 * Two modes:
 * - Channel mode (outboundChannel + outboundTarget set): conversation keyed by
 *   `${slug}:${channel}:${target}` — replies routed back via active triggers.
 * - Internal mode (no outboundChannel): fresh conversation per event keyed by
 *   `${slug}:webhook:${definitionId}:${ts}`. No outbound send, no reply routing.
 *   Used for one-shot agent actions whose history is consulted in the admin UI.
 */
export async function triggerConversation(
  instanceId: string,
  instanceSlug: InstanceSlug,
  definition: EventDefinition,
  payload: Record<string, unknown>,
): Promise<void> {
  const cycleStart = Date.now();

  if (!definition.contextPrompt) {
    webhookLog.warn("TriggerEngine", `definition "${definition.name}" missing contextPrompt`);
    return;
  }

  const hasChannel = !!definition.outboundChannel;
  const channelLabel = definition.outboundChannel ?? "webhook";

  const instanceConfig = await resolveInstanceConfig(instanceSlug);

  // 1. Render templates
  const rawContextPrompt = renderTemplate(definition.contextPrompt, payload);
  let renderedTarget: string | null = null;
  if (hasChannel) {
    renderedTarget = definition.outboundTarget
      ? renderTemplate(definition.outboundTarget, payload)
      : null;
    if (!renderedTarget) {
      webhookLog.warn("TriggerEngine", `definition "${definition.name}" outboundTarget resolved to empty`);
      return;
    }
  }

  // Truncate rendered context for safety (max 50KB).
  // The limit was originally 4KB but that's too small for structured
  // context prompts that include schemas, checklists, or URL constants
  // (e.g. a "Send proposal" flow renders to ~9KB). 50KB ≈ 12.5K tokens,
  // still well below any model's context window, and guards against
  // pathological payload expansion via `{{payload.*}}`.
  const MAX_RENDERED_CONTEXT_CHARS = 50_000;
  const renderedContextPrompt = rawContextPrompt.length > MAX_RENDERED_CONTEXT_CHARS
    ? rawContextPrompt.slice(0, MAX_RENDERED_CONTEXT_CHARS) + "\n[truncated]"
    : rawContextPrompt;

  const safeContextPrompt = renderedContextPrompt;

  // 2. Build conversation ID (channel-keyed or fresh per event in internal mode)
  const conversationId = hasChannel
    ? `${instanceSlug}:${definition.outboundChannel}:${renderedTarget}`
    : `${instanceSlug}:webhook:${definition.id}:${cycleStart}`;

  const ensureResult = await conversationStore.ensureConversation(conversationId, instanceSlug, {
    channel: channelLabel,
    source: "webhook",
    contextPrompt: safeContextPrompt,
  });

  // Activity-stream emit: lifecycle event when this webhook trigger materialises
  // a fresh conversation. Subsequent same-target triggers reuse the conversation
  // and stay silent here. Fire-and-forget.
  if (ensureResult.created) {
    resolveInstanceMeta(instanceSlug)
      .then((instance) => {
        emitConversation({
          conversationId,
          lifecycle: "created",
          source: "webhook",
          channel: definition.outboundChannel ?? undefined,
          instance,
        });
      })
      .catch(() => {
        /* swallow */
      });
  }

  // Persist the rendered contextPrompt as a system message in conversation
  // history, so structured fields from the original webhook payload (leadId,
  // appointmentTime, etc.) remain accessible to the agent across subsequent
  // inbound turns. The dedicated `contextPrompt` column is cleared by
  // clearContextPrompt() at the end of this trigger to avoid duplicating the
  // same content in the system prompt — but the history copy survives, which
  // is what multi-turn webhook flows need (e.g. reminder → bill upload → CRM
  // PATCH using leadId from the original trigger).
  await conversationStore.appendMessages(conversationId, [
    { role: "system", content: safeContextPrompt },
  ]);

  // 3. Register active trigger for reply routing + per-conversation trigger context (tools).
  //    Skipped in internal mode: no channel means no inbound replies to route, and
  //    no channel-aware tools rely on a trigger context.
  if (hasChannel && renderedTarget) {
    registerTrigger(instanceSlug, definition.outboundChannel!, renderedTarget, conversationId);
    setTriggerContext(conversationId, {
      instanceSlug,
      outboundChannel: definition.outboundChannel!,
      outboundTarget: renderedTarget,
    });
  }

  // Conversation state buffer (commit-on-success), mirroring the inbound pipeline:
  // tools invoked in the trigger turn can write trusted derived values via `ctx.state`
  // (e.g. an instance's init tool seeding offerType/leadId), persisted only after
  // supervise succeeds. Without this the trigger turn had no buffer and every state
  // write silently no-opped. Seed the trusted channel identity in channel mode so
  // tools also get `ctx.state.channel`.
  const stateBuffer = await ConversationStateBuffer.load(conversationId, instanceSlug).catch((err) => {
    webhookLog.error("TriggerEngine", `failed to load conversation state for ${conversationId}`, err);
    return new ConversationStateBuffer(conversationId, instanceSlug);
  });
  if (hasChannel && renderedTarget) {
    stateBuffer.seedChannel({ type: definition.outboundChannel!, id: renderedTarget });
  }

  webhookLog.info("TriggerEngine", `triggering conversation ${conversationId} for "${definition.name}"${hasChannel ? "" : " (internal mode)"}`);

  // 4. Synthetic user message — the actual instructions are in the contextPrompt (system prompt)
  const syntheticMessage = "A webhook event has been triggered. Follow the instructions in your conversation context.";

  const contextPrepMs = Date.now() - cycleStart;

  const messageToSupervise = syntheticMessage;

  // NOTE: the synthetic user message is passed to supervise() to satisfy the
  // provider's user/assistant alternation requirement, but it is intentionally
  // NOT persisted to conversation history — it would otherwise pollute the
  // admin UI, the summary, and the LLM's contextual view of the thread.
  // Caveat: if one day an instance switches to a provider that rejects
  // consecutive assistant messages (e.g. Anthropic), consecutive webhook
  // triggers without user replies in between will produce two assistant
  // messages in history. Handle at pipeline load-time (merge) when needed.

  // 5. Call supervisor — include harness tools gated by the outbound channel
  //    (e.g. "whatsapp" enables send_whatsapp_template) plus the
  //    `conversation-trigger` category (enables send_outbound_message, which
  //    lets the agent reply on the trigger's outbound channel).
  const harnessCategories = hasChannel
    ? new Set<string>([definition.outboundChannel!, "conversation-trigger"])
    : new Set<string>();
  let result;
  try {
    result = await supervise({
      message: messageToSupervise,
      instanceId: instanceSlug,
      conversationId,
      conversationSummary: undefined,
      contextPrompt: safeContextPrompt,
      channelIdentity: hasChannel && renderedTarget
        ? { channel: definition.outboundChannel!, channelId: renderedTarget }
        : undefined,
      provider: instanceConfig.provider,
      model: instanceConfig.model,
      apiKeys: instanceConfig.apiKeys,
      secrets: instanceConfig.secrets,
      memoryEnabled: instanceConfig.memoryEnabled,
      knowledgeEnabled: instanceConfig.knowledgeEnabled,
      thinkingEnabled: instanceConfig.thinkingEnabled,
      debugEnabled: instanceConfig.debugEnabled,
      includeHarness: harnessCategories,
      stateBuffer,
    });
  } catch (err) {
    webhookLog.error("TriggerEngine", `supervise() failed for "${definition.name}"`, err);
    if (hasChannel) clearTriggerContext(conversationId);
    return;
  }

  // Commit conversation state (commit-on-success): reached only when supervise
  // succeeded (the catch above returns). Awaited so a tool's derived value is
  // durable before the next inbound turn reads it. Errors logged, not propagated.
  try {
    await stateBuffer.flush();
  } catch (err) {
    webhookLog.error("TriggerEngine", `failed to flush conversation state for ${conversationId}`, err);
  }

  // When a tool has already delivered the reply (e.g. send_whatsapp_template),
  // persist the actual content delivered to the user (`replyText`) instead of
  // the supervisor's free-form meta-commentary (`result.text`). Keeps the
  // conversation history aligned with what the recipient actually saw.
  const finalText = result.replyHandled && result.replyText ? result.replyText : result.text;

  // Persist assistant response (tool-delivered content when replyHandled, else supervisor text)
  await conversationStore.appendMessages(conversationId, [
    { role: "assistant", content: finalText, steps: result.steps, ...(result.reasoning ? { reasoning: result.reasoning } : {}), ...(result.debugPayload ? { debugPayload: result.debugPayload } : {}) },
  ]);

  // Send response to the configured outbound channel — unless a tool has already
  // delivered the reply (e.g. send_whatsapp_template signaled replyHandled).
  // In internal mode (no channel) the response is only persisted, never sent.
  if (hasChannel && finalText && !result.replyHandled) {
    try {
      await channelManager.sendOutbound(instanceSlug, definition.outboundChannel!, renderedTarget!, finalText);
      webhookLog.info("TriggerEngine", `sent to ${definition.outboundChannel}:${renderedTarget}`);
    } catch (err) {
      webhookLog.error("TriggerEngine", `send failed for ${definition.outboundChannel}:${renderedTarget}`, err);
    }
  } else if (hasChannel && result.replyHandled) {
    webhookLog.info("TriggerEngine", `reply already handled by tool — skipping free-form send for ${definition.outboundChannel}:${renderedTarget}`);
  }

  // Clear trigger context — conversation-lifetime state is no longer needed.
  // Only set in channel mode, so only cleared in channel mode.
  if (hasChannel) clearTriggerContext(conversationId);

  // Clear the persisted contextPrompt: it was meant only for this trigger turn,
  // so subsequent inbound turns on the same conversation don't see stale
  // instructions. Fire-and-forget — errors logged, not propagated.
  conversationStore.clearContextPrompt(conversationId).catch((err) =>
    webhookLog.error("TriggerEngine", `failed to clear contextPrompt for ${conversationId}`, err),
  );

  // 6. Fire-and-forget post-processing
  const postProcess = async () => {
    await generateConversationTitle({
      conversationId,
      instanceId: instanceSlug,
      provider: instanceConfig.provider,
      apiKeys: instanceConfig.apiKeys,
      content: `Webhook trigger: ${definition.name}\nAssistant: ${finalText.slice(0, 300)}`,
      context: "This is a webhook-triggered outbound conversation.",
    });

    if (instanceConfig.memoryEnabled !== false) {
      extractMemories(conversationId, instanceSlug, instanceConfig.apiKeys, instanceConfig.provider).catch((err) =>
        webhookLog.error("PostProcess", "Memory extraction failed", err),
      );
    }
  };
  postProcess().catch((err) => webhookLog.error("PostProcess", "post-processing error", err));

  // Record trace
  traceStore.record({
    conversationId,
    instanceId: instanceSlug,
    channel: channelLabel,
    contextPrepMs,
    toolBuildingMs: result.toolBuildingMs,
    llmCallMs: result.durationMs,
    totalMs: Date.now() - cycleStart,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    toolCalls: result.toolCallTraces,
    isStreaming: false,
  });

  webhookLog.info("TriggerEngine", `conversation ${conversationId} completed (${Date.now() - cycleStart}ms)`);
}
