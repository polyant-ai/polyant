// SPDX-License-Identifier: AGPL-3.0-or-later

import type { InstanceSlug } from "../instances/identifiers.js";
import type { ConversationStateApi } from "../conversations/state.buffer.js";
import type { ChatRequest } from "../ai-gateway/types.js";
import type { HookResult, HookContext, HookFunctionDefinition, HookSpec } from "@polyant-ai/plugin-sdk";

export type { HookResult, HookContext, HookFunctionDefinition, HookSpec };

/** Payload of a halt: the message delivered to the user in place of the LLM turn. */
export interface HookHaltSignal {
  message: string;
}

/** Payload of a response replacement (post-LLM). */
export interface HookReplaceSignal {
  message: string;
}

/** Conversation lifecycle events a hook can subscribe to. */
export const HOOK_EVENTS = [
  "conversation_start",
  "message_received",
  "response_generated",
  "response_sent",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Action types. Only `function` after the tool→function cutover. */
export const HOOK_ACTION_TYPES = ["function"] as const;

export type HookActionType = (typeof HOOK_ACTION_TYPES)[number];

/** Per-action configuration stored in `instance_hooks.action_config` (jsonb). */
export interface HookActionConfig {
  /** Registered hook function to run. */
  functionName: string;
}

/** Server-built event payload — the ONLY source for template placeholders. */
export interface HookEventPayload {
  instance: { slug: string };
  conversation: { id: string };
  channel: { type: string; id: string };
  user: { name: string };
  message: { text: string };
  /** Present only on response_generated / response_sent. */
  response?: { text: string };
}

/** Runtime context threaded from the pipeline into hook execution. */
export interface HookRunContext {
  instanceId: InstanceSlug;
  conversationId: string;
  secrets: Record<string, string>;
  apiKeys?: ChatRequest["apiKeys"];
  provider?: string;
  /** Tier-resolved model override (e.g. "claude-x"), forwarded to ctx.ai / gateway. */
  model?: string;
  /** Per-instance behaviour flags surfaced to hook functions via ctx.instance.flags. */
  flags?: Record<string, boolean>;
  /** Per-run conversation state API (same buffer as the supervisor's tools). */
  state?: ConversationStateApi;
  /** Pipeline abort signal — remaining hooks are skipped once aborted. */
  abortSignal?: AbortSignal;
}

/** A hydrated `instance_hooks` row. */
export interface InstanceHookRow {
  id: string;
  instanceId: string;
  event: HookEvent;
  actionType: HookActionType;
  actionConfig: HookActionConfig;
  enabled: boolean;
  position: number;
  timeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Outcome of a single hook execution, returned by `runHooks()` so first-party
 * consumers (e.g. the typed SSE stream) can surface it live. Mirrors the
 * persisted `hook_executions` row minus the DB-generated fields.
 */
export interface HookExecutionSummary {
  hookId: string;
  event: HookEvent;
  actionType: HookActionType;
  toolName: string;
  success: boolean;
  error?: string;
  durationMs: number;
  /** Rendered tool args (post-template). Captured even when the execution fails. */
  args?: Record<string, unknown>;
  /** Tool result, JSON-stringified and truncated. */
  result?: string;
  /** Present when this hook's tool requested a halt (first halt wins). */
  halt?: HookHaltSignal;
  /** Present when this hook requested a post-LLM response replacement. */
  replaceResponse?: HookReplaceSignal;
  /** Present when this hook requested context injection. */
  injectContext?: string;
}

/**
 * Incremental capture of an execution's input/output, reported by the executor
 * via the `capture` callback so the runner can persist them even when the
 * execution later fails or times out.
 */
export interface HookExecutionCapture {
  args?: Record<string, unknown>;
  result?: string;
  /** Set when the executed tool requested a pipeline halt. */
  halt?: HookHaltSignal;
  /** Set when the hook requested a post-LLM response replacement. */
  replaceResponse?: HookReplaceSignal;
  /** Set when the hook requested context injection. */
  injectContext?: string;
}

/** One executor per action type, resolved by the runner from a registry map. */
export interface HookActionExecutor {
  execute(
    hook: InstanceHookRow,
    payload: HookEventPayload,
    ctx: HookRunContext,
    capture: (data: HookExecutionCapture) => void,
  ): Promise<void>;
}
