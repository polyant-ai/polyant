// SPDX-License-Identifier: AGPL-3.0-or-later

import { chat } from "../ai-gateway/index.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import type { EventDefinition } from "./webhook-sources.store.js";
import { webhookLog } from "./webhook-logger.js";

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
  const instanceConfig = await resolveInstanceConfig(asInstanceSlug(instanceSlug));
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
      { conversationId: `event-match:${def.id}`, instanceId: asInstanceSlug(instanceSlug), callType: "service" },
    );

    const answer = response.text.trim().toLowerCase();
    if (/^yes\b/.test(answer)) return def;

    // Anything that is neither a yes nor a no means the model did not comply
    // with the one-word instruction, and the payload is about to be dropped for
    // a reason that has nothing to do with the matching criteria. That drop is
    // indistinguishable from "no definition was interested": no retry, no
    // backlog row, no trace. Say so.
    //
    // The strict `answer === "yes"` this replaces made the same silent drop for
    // an answer as ordinary as "Yes." — it held only because the `fast` tier
    // happens to be obedient about one-word replies, which is a property of the
    // model rather than of this code.
    if (!/^no\b/.test(answer)) {
      webhookLog.warn(
        "EventMatcher",
        `definition "${def.name}" got a non-yes/no answer — treating as no match: ${JSON.stringify(answer.slice(0, 80))}`,
      );
    }
  }

  return null;
}
