// SPDX-License-Identifier: AGPL-3.0-or-later

import { chat } from "../ai-gateway/index.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { asAgentSlug } from "../instances/identifiers.js";
import type { EventDefinition } from "./webhook-sources.store.js";

/**
 * Match an incoming webhook payload against a list of event definitions.
 * Uses a tiny LLM (tier "fast") to evaluate each definition's matching prompt.
 * Returns the first matching definition, or null if none match.
 */
export async function matchEvent(
  payload: Record<string, unknown>,
  definitions: EventDefinition[],
  instanceSlug: string,
): Promise<EventDefinition | null> {
  const instanceConfig = await resolveInstanceConfig(asAgentSlug(instanceSlug));
  const apiKeys = instanceConfig.apiKeys;
  const provider = instanceConfig.provider;

  const payloadStr = JSON.stringify(payload, null, 2);

  // Sequential evaluation: definitions are priority-ordered, first match wins.
  // Parallel would evaluate all definitions even after a match, wasting LLM calls.
  for (const def of definitions) {
    const response = await chat(
      {
        tier: "fast",
        provider,
        apiKeys,
        system: `You are an event classifier. Given a webhook payload and a description of what events to match, respond with ONLY "yes" or "no". Nothing else.`,
        messages: [
          {
            role: "user",
            content: `## Matching criteria\n${def.matchingPrompt}\n\n## Webhook payload\n${payloadStr}\n\nDoes this payload match the criteria? Answer only "yes" or "no".`,
          },
        ],
      },
      { conversationId: `event-match:${def.id}`, agentId: asAgentSlug(instanceSlug), callType: "service" },
    );

    const answer = response.text.trim().toLowerCase();
    if (answer === "yes") return def;
  }

  return null;
}
