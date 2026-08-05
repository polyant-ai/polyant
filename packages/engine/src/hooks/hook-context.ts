// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";
import type {
  HookContext,
  ConversationHistoryApi,
  ConversationStateApi,
  AuditLogger,
} from "@polyant-ai/plugin-sdk";
import { chat } from "../ai-gateway/index.js";
import type { HookRunContext, HookEventPayload, HookEvent } from "./hook-types.js";

/**
 * Build the concrete HookContext handed to a hook handler. `conversation` and
 * `audit` are provided by the caller (the executor), obtained the same way
 * `buildTool` obtains them for tools.
 */
export function buildHookContext(
  event: HookEvent,
  payload: HookEventPayload,
  ctx: HookRunContext,
  conversation: ConversationHistoryApi,
  audit: AuditLogger,
): HookContext {
  return {
    event,
    payload,
    conversation,
    state: ctx.state ?? emptyState(),
    secrets: ctx.secrets,
    instance: { slug: ctx.instanceId, provider: ctx.provider, model: ctx.model, flags: ctx.flags ?? {} },
    apiKeys: ctx.apiKeys,
    ai: {
      async chat(input) {
        const messages: ModelMessage[] = input.messages.map(
          (m) => ({ role: m.role, content: m.content }) as ModelMessage,
        );
        const res = await chat(
          {
            tier: input.tier ?? "standard",
            provider: ctx.provider,
            model: ctx.model,
            apiKeys: ctx.apiKeys,
            system: input.system,
            messages,
            abortSignal: ctx.abortSignal,
          },
          { conversationId: ctx.conversationId, instanceId: ctx.instanceId, callType: "service" },
        );
        return res.text;
      },
    },
    audit,
    abortSignal: ctx.abortSignal,
  };
}

/** No-op state for engines/paths that build a HookContext without a state buffer. */
function emptyState(): ConversationStateApi {
  return { get: () => undefined, set: () => {}, getAll: () => ({}), delete: () => {}, channel: undefined };
}
