// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";
import type { Instance } from "@/lib/api";
import type { OnboardingState, WizardStepId, WizardStepState } from "@/lib/api-types";
import { SECRET_KEYS } from "@/lib/provider-secrets";
import { WIZARD_STEP_IDS } from "./steps";

/** How many agents are looked into for credentials, channels and knowledge. */
const SAMPLED_AGENTS = 5;

/** The secrets that count as «a key for a model provider». */
const PROVIDER_KEYS: ReadonlySet<string> = new Set([
  SECRET_KEYS.OPENAI,
  SECRET_KEYS.ANTHROPIC,
  SECRET_KEYS.NEBIUS,
  SECRET_KEYS.BEDROCK_API_KEY,
  SECRET_KEYS.AWS_PROVIDER_ACCESS_KEY_ID,
]);

/**
 * What exists, whoever set it up and wherever: the wizard, the agent's own pages,
 * or an import. The «First steps» card reads this instead of trusting what the
 * wizard recorded, so configuring everything outside the wizard still ticks the
 * steps.
 */
export interface SetupFacts {
  /** An agent holds a key for a model provider. */
  provider: boolean;
  /** At least one agent exists. */
  agent: boolean;
  /** An agent has a provider and model of its own chosen. */
  model: boolean;
  /** An agent has a channel switched on. */
  channel: boolean;
  /** An agent has at least one knowledge document. */
  knowledge: boolean;
  /** At least one conversation exists. */
  conversation: boolean;
}

/** Whether a step is satisfied by what exists. The welcome step has nothing to verify. */
export function stepDoneByFacts(facts: SetupFacts, id: WizardStepId): boolean {
  switch (id) {
    case "welcome":
      return true;
    case "provider":
      return facts.provider;
    case "model":
      return facts.model && facts.provider;
    case "agent":
      return facts.agent;
    case "chat":
      return facts.conversation;
    case "channels":
      return facts.channel;
    case "knowledge":
      return facts.knowledge;
  }
}

/** The step as the card shows it: done when it exists, otherwise what the person recorded. */
export function effectiveStepState(
  onboarding: OnboardingState,
  facts: SetupFacts,
  id: WizardStepId,
): WizardStepState {
  if (stepDoneByFacts(facts, id)) return "done";
  const recorded = onboarding.steps[id] ?? "todo";
  // A step recorded done in the wizard whose result no longer exists is open again.
  return recorded === "done" ? "todo" : recorded;
}

export function remainingByFacts(onboarding: OnboardingState, facts: SetupFacts): WizardStepId[] {
  return WIZARD_STEP_IDS.filter((id) => effectiveStepState(onboarding, facts, id) !== "done");
}

/**
 * The card shows while something is open and goes away when everything is done.
 * It waits while the wizard has not been left yet (the wizard is on screen then),
 * and «Don't show again» silences it for good.
 */
export function showSetupCard(onboarding: OnboardingState, facts: SetupFacts): boolean {
  if (onboarding.wizard === "dismissed" || onboarding.wizard === "new") return false;
  return remainingByFacts(onboarding, facts).length > 0;
}

/** Where the wizard reopens from the card: the first step still open. */
export function firstOpenByFacts(onboarding: OnboardingState, facts: SetupFacts): number {
  const index = WIZARD_STEP_IDS.findIndex((id) => effectiveStepState(onboarding, facts, id) !== "done");
  return Math.max(index, 0);
}

async function attempt<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    // A read the caller's role does not allow says «not known to exist», which
    // leaves the step open: the card then offers it, which is harmless.
    return fallback;
  }
}

/** Reads the facts for the workspace the panel addresses. */
export async function loadSetupFacts(): Promise<SetupFacts> {
  const { instances } = await api.instances.list();
  const sample: Instance[] = instances.slice(0, SAMPLED_AGENTS);

  const [provider, channel, knowledge, conversation] = await Promise.all([
    attempt(async () => {
      const lists = await Promise.all(sample.map((i) => api.secrets.list(i.slug)));
      return lists.some((l) => l.secrets.some((s) => s.configured && PROVIDER_KEYS.has(s.key)));
    }, false),
    attempt(async () => {
      const lists = await Promise.all(sample.map((i) => api.channels.list(i.slug)));
      return lists.some((l) => l.channels.some((c) => c.enabled));
    }, false),
    attempt(async () => {
      const lists = await Promise.all(sample.map((i) => api.knowledge.list(i.slug)));
      return lists.some((l) => l.documents.length > 0);
    }, false),
    attempt(async () => (await api.conversations.list({ limit: 1 })).total > 0, false),
  ]);

  return {
    provider,
    agent: instances.length > 0,
    model: sample.some((i) => i.provider !== null && i.model !== null),
    channel,
    knowledge,
    conversation,
  };
}
