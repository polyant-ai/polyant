// SPDX-License-Identifier: AGPL-3.0-or-later

import { supervise, type SupervisorInput, type SupervisorOutput } from "./supervisor/index.js";
import { runHooks, firstHalt, firstReplaceResponse, hookProvenance, warnUnhonoredControls } from "../hooks/hook-runner.js";
import type { HookEventPayload, HookRunContext } from "../hooks/hook-types.js";
import type { ConversationStateBuffer } from "../conversations/state.buffer.js";
import { conversationStore } from "../conversations/index.js";
import { traceStore } from "../analytics/trace.store.js";
import { extractMemories } from "../memory/extractor.js";
import { generateConversationTitle } from "../utils/title-generator.js";
import type { InstanceConfig } from "../instances/config-resolver.js";
import type { InstanceSlug } from "../instances/identifiers.js";
import type { Logger } from "../utils/create-logger.js";

/**
 * The turn shared by the engines that call `supervise()` directly (Room and
 * webhook triggers): no replay loop, no streaming, one reply per run.
 *
 * The order is the point and lives here once: the `message_received` hooks can
 * halt the turn before the model is called; the `response_generated` hooks see
 * the model's text before anything is committed; the conversation state is
 * flushed only after both have run. Each engine keeps what is its own — what
 * the message says, where the reply goes, what is logged — and reads the result.
 *
 * Hooks cannot ask a direct turn to regenerate or inject context, so only
 * `halt` and `replaceResponse` are honored; the others are warned about by name.
 */
const DIRECT_HOOK_CONTROLS = ["halt", "replaceResponse"] as const;

/** The supervisor inputs an engine adds to the ones every direct turn shares. */
export type DirectTurnSupervisorExtras = Pick<
  SupervisorInput,
  | "conversationHistory"
  | "contextPrompt"
  | "channelIdentity"
  | "knowledgeEnabled"
  | "roomPrompt"
  | "includeHarness"
>;

export interface DirectTurnInput {
  /** Names the engine in the warning for a hook control it cannot honor. */
  source: "room" | "webhook";
  instanceSlug: InstanceSlug;
  instanceConfig: InstanceConfig;
  conversationId: string;
  stateBuffer: ConversationStateBuffer;
  /** The event the hooks see; its `message.text` is what `supervise()` is given. */
  hookPayload: HookEventPayload;
  supervisorExtras: DirectTurnSupervisorExtras;
  /** The text a model result puts forward as the reply. Defaults to the supervisor's text. */
  replyTextOf?: (result: SupervisorOutput) => string;
  /** Called when `supervise()` throws; the turn then ends without hooks or a flush. */
  onSuperviseError: (err: unknown) => void | Promise<void>;
  log: Logger;
  /** The log scope the engine uses (`RoomCycle`, `TriggerEngine`). */
  scope: string;
}

export interface DirectTurnOutcome {
  /** What the turn replies with: the halt message, a hook's replacement, or the model's text. */
  finalText: string;
  /** Undefined when a pre-LLM hook halted the turn before the model was called. */
  result: SupervisorOutput | undefined;
  /** The hook that authored the reply, for the persisted message's metadata. */
  provenance: ReturnType<typeof hookProvenance>;
  halted: boolean;
}

/** Returns undefined when `supervise()` failed (after `onSuperviseError` ran). */
export async function runDirectTurn(input: DirectTurnInput): Promise<DirectTurnOutcome | undefined> {
  const { instanceConfig: cfg, stateBuffer } = input;
  const hookCtx: HookRunContext = {
    instanceId: input.instanceSlug,
    conversationId: input.conversationId,
    secrets: cfg.secrets,
    apiKeys: cfg.apiKeys,
    provider: cfg.provider,
    model: cfg.model,
    flags: {
      memory: cfg.memoryEnabled,
      knowledge: cfg.knowledgeEnabled,
      thinking: cfg.thinkingEnabled,
      debug: cfg.debugEnabled,
      stateInPrompt: cfg.stateInPromptEnabled,
      toolResultsInHistory: cfg.toolResultsInHistoryEnabled,
    },
    state: stateBuffer.api(),
  };

  // Pre-LLM hook (halt-capable). Keep the summaries for provenance on halt.
  const preHookSummaries = await runHooks("message_received", input.hookPayload, hookCtx);
  warnUnhonoredControls(preHookSummaries, input.source, DIRECT_HOOK_CONTROLS);
  const halt = firstHalt(preHookSummaries);

  let result: SupervisorOutput | undefined;
  if (!halt) {
    try {
      result = await supervise({
        message: input.hookPayload.message.text,
        instanceId: input.instanceSlug,
        conversationId: input.conversationId,
        provider: cfg.provider,
        model: cfg.model,
        apiKeys: cfg.apiKeys,
        secrets: cfg.secrets,
        memoryEnabled: cfg.memoryEnabled,
        thinkingEnabled: cfg.thinkingEnabled,
        debugEnabled: cfg.debugEnabled,
        datetimeInjectionEnabled: cfg.datetimeInjectionEnabled,
        datetime: cfg.datetime,
        cacheConfig: cfg.cacheConfig,
        stateBuffer,
        // A direct turn has no browser present to authorize an MCP oauth server,
        // even when the conversation id happens to be stable. Leave MCP oauth
        // servers off (design spec §8.3); see SupervisorInput.allowOAuth.
        allowOAuth: false,
        ...input.supervisorExtras,
      });
    } catch (err) {
      await input.onSuperviseError(err);
      return undefined;
    }
  }

  // Post-LLM hook (response-replacement capable). A direct turn is non-streaming,
  // so a replace always applies. Only runs on the non-halt path (result is defined).
  // response_generated hooks can also write state, so they run BEFORE the flush.
  let replace: ReturnType<typeof firstReplaceResponse>;
  let postHooks = preHookSummaries; // default to pre-summaries so provenance covers the halt case
  if (!halt) {
    postHooks = await runHooks(
      "response_generated",
      // No replay loop, so regenerationCount is always 0.
      { ...input.hookPayload, response: { text: result!.text, regenerationCount: 0 } },
      hookCtx,
    );
    warnUnhonoredControls(postHooks, input.source, DIRECT_HOOK_CONTROLS);
    replace = firstReplaceResponse(postHooks);
  }

  // Reply precedence: a pre-LLM halt, then a post-LLM replaceResponse (a hook
  // explicitly rewrote the reply), then the model's own text.
  const finalText = halt
    ? halt.message
    : replace
      ? replace.message
      : (input.replyTextOf ?? ((r: SupervisorOutput) => r.text))(result!);
  // Provenance: the pre-LLM halt or the post-LLM replace that authored the reply.
  const provenance = halt ? hookProvenance(preHookSummaries) : hookProvenance(postHooks);

  // Commit conversation state (commit-on-success): reached only after supervise
  // succeeded and the response_generated hooks ran. Awaited so a tool's derived
  // value is durable before the next inbound turn reads it. Errors are logged,
  // not propagated.
  try {
    await stateBuffer.flush();
  } catch (err) {
    input.log.error(input.scope, `failed to flush conversation state for ${input.conversationId}`, err);
  }

  return { finalText, result, provenance, halted: !!halt };
}

/** Persist the turn's reply as the assistant message, with the model's steps and the hook provenance. */
export function persistDirectReply(conversationId: string, outcome: DirectTurnOutcome): Promise<void> {
  const { finalText, result, provenance } = outcome;
  return conversationStore.appendMessages(conversationId, [
    {
      role: "assistant",
      content: finalText,
      steps: result?.steps,
      ...(result?.reasoning ? { reasoning: result.reasoning } : {}),
      ...(result?.debugPayload ? { debugPayload: result.debugPayload } : {}),
      ...(provenance ? { metadata: provenance } : {}),
    },
  ]);
}

/** Fire-and-forget after the reply: the conversation title, then memory extraction when enabled. */
export function postProcessDirectTurn(input: {
  conversationId: string;
  instanceSlug: InstanceSlug;
  instanceConfig: InstanceConfig;
  titleContent: string;
  titleContext: string;
  log: Logger;
}): void {
  const { instanceConfig: cfg, log } = input;
  const run = async () => {
    await generateConversationTitle({
      conversationId: input.conversationId,
      instanceId: input.instanceSlug,
      provider: cfg.provider,
      apiKeys: cfg.apiKeys,
      content: input.titleContent,
      context: input.titleContext,
    });

    if (cfg.memoryEnabled !== false) {
      extractMemories(input.conversationId, input.instanceSlug, cfg.apiKeys, cfg.provider).catch((err) =>
        log.error("PostProcess", "Memory extraction failed", err),
      );
    }
  };
  run().catch((err) => log.error("PostProcess", "post-processing error", err));
}

/** Record the pipeline trace of a direct turn. */
export function recordDirectTurnTrace(input: {
  conversationId: string;
  instanceSlug: InstanceSlug;
  channel: string;
  contextPrepMs: number;
  cycleStart: number;
  result: SupervisorOutput | undefined;
}): void {
  const { result } = input;
  traceStore.record({
    conversationId: input.conversationId,
    instanceId: input.instanceSlug,
    channel: input.channel,
    contextPrepMs: input.contextPrepMs,
    toolBuildingMs: result?.toolBuildingMs ?? 0,
    llmCallMs: result?.durationMs ?? 0,
    totalMs: Date.now() - input.cycleStart,
    promptTokens: result?.usage?.promptTokens ?? 0,
    completionTokens: result?.usage?.completionTokens ?? 0,
    toolCalls: result?.toolCallTraces,
    isStreaming: false,
  });
}
