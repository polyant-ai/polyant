// SPDX-License-Identifier: AGPL-3.0-or-later

import type { InstanceSlug } from "../instances/identifiers.js";
import type { ConversationStateApi } from "../conversations/state.buffer.js";
import type { ChatRequest } from "../ai-gateway/types.js";

/** Conversation lifecycle events a hook can subscribe to. */
export const HOOK_EVENTS = [
  "conversation_start",
  "message_received",
  "response_generated",
  "response_sent",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Action types. v1 implements only `tool`; future types are additive. */
export const HOOK_ACTION_TYPES = ["tool"] as const;

export type HookActionType = (typeof HOOK_ACTION_TYPES)[number];

/**
 * Per-action configuration stored in `instance_hooks.action_config` (jsonb).
 * For `tool` actions: which registered tool to run and the args template
 * ({{path}} placeholders resolved against the event payload).
 */
export interface HookActionConfig {
  toolName: string;
  args: Record<string, unknown>;
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

/** One executor per action type, resolved by the runner from a registry map. */
export interface HookActionExecutor {
  execute(
    hook: InstanceHookRow,
    payload: HookEventPayload,
    ctx: HookRunContext,
  ): Promise<void>;
}
