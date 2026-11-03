// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ModelMessage } from "ai";
import type { HookAi } from "@polyant-ai/plugin-sdk";
import { chat, type ChatCallOptions } from "./index.js";
import type { ChatRequest } from "./types.js";

/**
 * The `ctx.ai` a hook or a tool receives: one short LLM answer through the
 * gateway, on the agent's provider and keys, so the call is logged, priced and
 * attributed like any other service call of the turn. The caller picks a tier
 * and nothing else; `abortSignal` stops the call once nobody waits for it.
 * A `model` in `request` (hooks pass the agent's model, tools pass none) is the
 * model of the standard tier only: a fast or heavy request runs on that tier's
 * model of the agent's provider, so a hook asking for a quick classification
 * does not pay for the agent's main model.
 */
export function agentAi(
  request: Pick<ChatRequest, "provider" | "model" | "apiKeys" | "abortSignal" | "langsmith">,
  options: Omit<ChatCallOptions, "callType">,
): HookAi {
  return {
    async chat(input) {
      const messages: ModelMessage[] = input.messages.map(
        (m) => ({ role: m.role, content: m.content }) as ModelMessage,
      );
      const tier = input.tier ?? "standard";
      const { model, ...agent } = request;
      const res = await chat(
        { ...agent, ...(model && tier === "standard" ? { model } : {}), tier, system: input.system, messages },
        { ...options, callType: "service" },
      );
      return res.text;
    },
  };
}
