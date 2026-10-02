// SPDX-License-Identifier: AGPL-3.0-or-later

import { chat } from "../ai-gateway/index.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import type { EventDefinition } from "./webhook-sources.store.js";
import { webhookLog } from "./webhook-logger.js";
import { projectEventPayload } from "../room/payload-projection.js";

/**
 * Verdicts accepted as a match. Kept deliberately tight: this set is what wakes
 * an agent up, so a token admitted here by mistake triggers a conversation on a
 * payload nobody asked about.
 */
const YES_TOKENS = new Set(["yes"]);

/**
 * Yes-words accepted only when they are the WHOLE reply, decoration aside. Each
 * is also an ordinary word: "Si tratta di…" opens an Italian sentence and
 * "y = …" a formula, so as the first word of a longer reply they say nothing
 * about the verdict. Italian is here at all because the matching prompts are
 * author-written and a criterion written in Italian pulls the reply into it.
 */
const BARE_YES_TOKENS = new Set(["y", "sì", "si"]);

/**
 * Verdicts accepted as a non-match. This set only decides whether we warn, so
 * it can afford to be generous where YES_TOKENS cannot: a no misread as
 * non-compliance costs one log line. Hedging ("not sure", "unclear") is left
 * out on purpose — that IS non-compliance and the warning should fire.
 */
const NO_TOKENS = new Set(["no", "n", "none", "nope", "negative", "false"]);

/**
 * Read the classifier's verdict from a reply that may be decorated.
 *
 * The prompt asks for a bare "yes"/"no" and the `fast` tier usually obliges, but
 * "**yes**", `"yes"`, "Answer: yes" and "Yes." are the same answer wearing
 * markdown, quotes, a label or punctuation. Strip the decoration once rather
 * than growing a pattern per shape, then compare the first word against a closed
 * set. Only the first word counts: a reply that argues before deciding is not a
 * verdict this function is willing to guess at, and returning null routes it to
 * the warning instead of to a silent drop. The ambiguous yes-words in
 * BARE_YES_TOKENS must also be the only word.
 */
function readVerdict(text: string): "yes" | "no" | null {
  const head = text
    .trim()
    .toLowerCase()
    // Leading markdown, quotes, bullets, code fences, numbering.
    .replace(/^[^\p{L}]+/u, "")
    // A label the model prepended to the verdict it was asked for.
    .replace(/^(?:answer|response|verdict|result|risposta)\b[^\p{L}]*/u, "");

  const token = /^\p{L}+/u.exec(head)?.[0];
  if (!token) return null;
  if (YES_TOKENS.has(token)) return "yes";
  const alone = head.slice(token.length).replace(/[^\p{L}\p{N}]+/gu, "") === "";
  if (alone && BARE_YES_TOKENS.has(token)) return "yes";
  if (NO_TOKENS.has(token)) return "no";
  return null;
}

/**
 * Match an incoming webhook payload against a list of event definitions.
 * Uses a tiny LLM (tier "fast") to evaluate each definition's matching prompt.
 * Returns the first matching definition, or null if none match.
 *
 * `sourceType` selects the same render-time projection the Room applies: the
 * payload is sent once per definition, so the noise it drops (API URL
 * templates, node ids) would otherwise be paid for on every classifier call.
 */
export async function matchEvent(
  payload: Record<string, unknown>,
  definitions: EventDefinition[],
  instanceSlug: string,
  sourceType?: string,
): Promise<EventDefinition | null> {
  const instanceConfig = await resolveInstanceConfig(asInstanceSlug(instanceSlug));
  const apiKeys = instanceConfig.apiKeys;
  const provider = instanceConfig.provider;

  const payloadStr = JSON.stringify(projectEventPayload(sourceType, payload), null, 2);

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

    const verdict = readVerdict(response.text);
    if (verdict === "yes") return def;

    // Neither a yes nor a no means the model did not comply with the one-word
    // instruction, and the payload is about to be dropped for a reason that has
    // nothing to do with the matching criteria. That drop is indistinguishable
    // from "no definition was interested": no retry, no backlog row, and a
    // controller log line that says "no match" — which in this case is a lie.
    // Say so here, where the difference is still visible.
    if (verdict === null) {
      webhookLog.warn(
        "EventMatcher",
        `definition "${def.name}" got a non-yes/no answer — treating as no match: ${JSON.stringify(response.text.trim().slice(0, 80))}`,
      );
    }
  }

  return null;
}
