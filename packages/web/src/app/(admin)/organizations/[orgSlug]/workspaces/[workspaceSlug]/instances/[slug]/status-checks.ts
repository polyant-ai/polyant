// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TranslationKey } from "@/lib/i18n/types";
import type {
  ChannelConfig,
  Instance,
  InstanceHook,
  KnowledgeDocument,
  RoomConfigResponse,
  SecretStatus,
  SkillState,
  ToolState,
} from "@/lib/api";

/**
 * What the agent page cannot see by looking at one section: configurations that
 * are green everywhere in the panel and do nothing at runtime.
 *
 * A PURE function over everything the Stato page has already loaded. Pure because
 * the value here is the rules, and rules that live inside a component with six
 * `useEffect`s cannot be argued with in a test — this file's own test is the
 * specification of what each check means.
 *
 * The rules the catalogue is built on, and the reason several plausible checks are
 * NOT here:
 *
 *  1. **Every check has a destination.** Without a section to go and fix it, an
 *     alert is a complaint. `section` is not optional.
 *  2. **Falsifiable, never probabilistic.** "The prompt looks long" is not a
 *     check. "Three tools never reach the model because their keys are missing"
 *     is: it is either true or it is not.
 *  3. **What is normal for many agents is a note, not a warning.** No tools
 *     enabled is the right shape for an agent that only talks, so it does not
 *     count toward the verdict.
 *  4. **Compare the agent with its own past, not with a threshold of ours.**
 *     Which is why the latency and cost checks are absent from this first pass:
 *     they need the previous period, and a fixed ">5s" is an opinion that ages.
 *  5. **Silenceable per agent** — not implemented yet, deliberately: it needs
 *     somewhere to persist the dismissal, and shipping the list without it is
 *     safe as long as the list stays short and true.
 */

export type CheckSeverity = "broken" | "warning" | "note";

export interface AgentCheck {
  /** Stable id — the key a future "silence this" would persist. */
  id: string;
  severity: CheckSeverity;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /** Interpolated into both title and body. */
  params?: Record<string, string | number>;
  /** The `?tab=` value of the section that turns this off. */
  section: string;
  sectionKey: TranslationKey;
}

export interface StatusCheckInput {
  instance: Instance;
  tools: ToolState[];
  skills: SkillState[];
  /** `null` when the caller could not read them (a viewer): the secret checks are skipped. */
  secrets: SecretStatus[] | null;
  channels: ChannelConfig[] | null;
  documents: KnowledgeDocument[] | null;
  hooks: InstanceHook[] | null;
  /** Names the hook registry knows — a hook outside this list cannot fire. */
  hookFunctions: string[] | null;
  room: RoomConfigResponse | null;
  /** How many contacts opted out in the last 7 days. */
  recentOptOuts: number | null;
  /** Contacts currently opted out, whatever the switch says. */
  optedOutCount: number | null;
}

/** Channels whose adapter cannot start without these config keys. */
const CHANNEL_REQUIRED_FIELDS: Record<string, string[]> = {
  telegram: ["botToken"],
  slack: ["botToken", "appToken", "signingSecret"],
  whatsapp: ["accountSid", "authToken", "whatsappNumber"],
};

const OPT_OUT_ALERT_THRESHOLD = 5;

/**
 * The one key a provider cannot run without.
 *
 * `bedrock` is not here on purpose: it authenticates through the host's AWS
 * profile or IAM role when no key is set, so an alert would fire on a working
 * agent.
 */
const PROVIDER_REQUIRED_SECRET: Record<string, string> = {
  openai: "openai_api_key",
  anthropic: "anthropic_api_key",
  nebius: "nebius_api_key",
};

export function runStatusChecks(input: StatusCheckInput): AgentCheck[] {
  const {
    instance,
    tools,
    skills,
    secrets,
    channels,
    documents,
    hooks,
    hookFunctions,
    room,
    recentOptOuts,
    optedOutCount,
  } = input;

  const checks: AgentCheck[] = [];
  const configuredSecrets = new Set(
    (secrets ?? []).filter((s) => s.configured).map((s) => s.key),
  );
  // An agent's own keys are all there is here. Enterprise adds a second source —
  // its organization's shared credentials, which the engine falls back to — and
  // there this set is the union of the two, in that order.
  const effectiveSecrets = configuredSecrets;

  // ── Silently broken ──────────────────────────────────────────────────

  /*
    The one that started the catalogue. `supervisor/index.ts` skips a tool whose
    non-optional secret keys are unset — so the tool is enabled in the panel, the
    model never sees it, and nothing is logged. Skipped entirely when the caller
    cannot read secrets: "unknown" must not read as "missing".
  */
  if (secrets !== null) {
    const starved = tools.filter(
      (tool) =>
        tool.enabled &&
        (tool.requiredSecrets ?? []).some(
          (spec) => spec.optional !== true && !configuredSecrets.has(spec.key),
        ),
    );
    if (starved.length > 0) {
      checks.push({
        id: "tools-missing-secrets",
        severity: "broken",
        titleKey: "status.check.toolsMissingSecrets.title",
        bodyKey: "status.check.toolsMissingSecrets.body",
        params: { count: starved.length, names: starved.map((t) => t.name).join(", ") },
        section: "toolSecrets",
        sectionKey: "instances.detail.tabToolSecrets",
      });
    }

    const starvedSkills = skills.filter(
      (skill) => skill.enabled && skill.requiredEnv?.length && skill.envConfigured === false,
    );
    if (starvedSkills.length > 0) {
      checks.push({
        id: "skills-missing-env",
        severity: "warning",
        titleKey: "status.check.skillsMissingEnv.title",
        bodyKey: "status.check.skillsMissingEnv.body",
        params: { count: starvedSkills.length, names: starvedSkills.map((s) => s.name).join(", ") },
        section: "skills",
        sectionKey: "instances.detail.tabSkills",
      });
    }
  }

  /*
    No key for the chat provider: every turn fails at the first token, and it is
    the only defect on this page that stops the agent answering at all.

    AWS is deliberately absent from the required set: Bedrock falls back to the
    host's AWS profile or IAM role (the Credenziali page says so), so "no key" is
    a normal, working configuration there and an alert would be a false alarm.
  */
  if (secrets !== null && instance.provider && PROVIDER_REQUIRED_SECRET[instance.provider]) {
    const key = PROVIDER_REQUIRED_SECRET[instance.provider];
    if (!effectiveSecrets.has(key)) {
      checks.push({
        id: "provider-no-credentials",
        severity: "broken",
        titleKey: "status.check.providerCredentials.title",
        bodyKey: "status.check.providerCredentials.body",
        params: { provider: instance.provider },
        section: "credentials",
        sectionKey: "instances.detail.tabCredentials",
      });
    }
  }

  // Retrieval and memory both embed, so both die the same way. The engine reports
  // this on the instance — a client-side rule would not see the AWS_REGION fallback.
  if (
    (instance.knowledgeEnabled && instance.embedder?.needsCredentials) ||
    (instance.memoryEnabled && instance.memory?.needsOpenAIKey)
  ) {
    checks.push({
      id: "embedder-no-credentials",
      severity: "broken",
      titleKey: "status.check.embedderCredentials.title",
      bodyKey: "status.check.embedderCredentials.body",
      section: "credentials",
      sectionKey: "instances.detail.tabCredentials",
    });
  }

  if (documents !== null) {
    if (instance.knowledgeEnabled && documents.length === 0) {
      checks.push({
        id: "knowledge-empty",
        severity: "broken",
        titleKey: "status.check.knowledgeEmpty.title",
        bodyKey: "status.check.knowledgeEmpty.body",
        section: "knowledge",
        sectionKey: "instances.detail.tabKnowledge",
      });
    }
    if (!instance.knowledgeEnabled && documents.length > 0) {
      checks.push({
        id: "knowledge-unused",
        severity: "warning",
        titleKey: "status.check.knowledgeUnused.title",
        bodyKey: "status.check.knowledgeUnused.body",
        params: { count: documents.length },
        section: "knowledge",
        sectionKey: "instances.detail.tabKnowledge",
      });
    }
    const failed = documents.filter((d) => d.status === "error");
    if (failed.length > 0) {
      checks.push({
        id: "knowledge-errors",
        severity: "broken",
        titleKey: "status.check.knowledgeErrors.title",
        bodyKey: "status.check.knowledgeErrors.body",
        params: { count: failed.length },
        section: "knowledge",
        sectionKey: "instances.detail.tabKnowledge",
      });
    }
  }

  // A hook whose function left the registry cannot fire. The Hook section marks it
  // "Non disponibile" — but only for someone who opens that section.
  if (hooks !== null && hookFunctions !== null) {
    const known = new Set(hookFunctions);
    const orphans = hooks.filter((h) => h.enabled && !known.has(h.actionConfig.functionName));
    if (orphans.length > 0) {
      checks.push({
        id: "hooks-unknown-function",
        severity: "broken",
        titleKey: "status.check.hooksOrphan.title",
        bodyKey: "status.check.hooksOrphan.body",
        params: { count: orphans.length },
        section: "hooks",
        sectionKey: "instances.detail.tabHooks",
      });
    }
  }

  if (channels !== null) {
    const enabled = channels.filter((c) => c.enabled);

    const broken = enabled.filter((c) => {
      const required = CHANNEL_REQUIRED_FIELDS[c.channelType];
      if (!required) return false;
      const config = (c.config ?? {}) as Record<string, unknown>;
      return required.some((key) => {
        const value = config[key];
        return typeof value !== "string" || value.trim() === "";
      });
    });
    if (broken.length > 0) {
      checks.push({
        id: "channels-incomplete",
        severity: "broken",
        titleKey: "status.check.channelIncomplete.title",
        bodyKey: "status.check.channelIncomplete.body",
        params: { names: broken.map((c) => c.channelType).join(", ") },
        section: "channels",
        sectionKey: "instances.detail.tabChannels",
      });
    }

    // Configuration alive on a switched-off agent: the case where "it stopped
    // answering" has its cause one row away.
    if (instance.status !== "active" && enabled.length > 0) {
      checks.push({
        id: "inactive-with-channels",
        severity: "broken",
        titleKey: "status.check.inactiveWithChannels.title",
        bodyKey: "status.check.inactiveWithChannels.body",
        params: { count: enabled.length },
        section: "general",
        sectionKey: "instances.detail.tabGeneral",
      });
    }

    if (enabled.length === 0 && instance.status === "active") {
      checks.push({
        id: "no-channels",
        severity: "note",
        titleKey: "status.check.noChannels.title",
        bodyKey: "status.check.noChannels.body",
        section: "channels",
        sectionKey: "instances.detail.tabChannels",
      });
    }
  }

  // `room-engine.ts` only sends when channel AND target are both set: without
  // them the room evaluates events and throws the answer away.
  if (room?.enabled) {
    if (!room.outboundChannel || !room.outboundTarget) {
      checks.push({
        id: "room-no-outbound",
        severity: "broken",
        titleKey: "status.check.roomNoOutbound.title",
        bodyKey: "status.check.roomNoOutbound.body",
        section: "room",
        sectionKey: "instances.detail.tabRoom",
      });
    }
    if (!room.prompt || room.prompt.trim() === "") {
      checks.push({
        id: "room-no-prompt",
        severity: "warning",
        titleKey: "status.check.roomNoPrompt.title",
        bodyKey: "status.check.roomNoPrompt.body",
        section: "room",
        sectionKey: "instances.detail.tabRoom",
      });
    }
  }

  const servedTools = tools.filter((t) => t.enabled).length;


  if (servedTools === 0) {
    checks.push({
      id: "no-tools",
      severity: "note",
      titleKey: "status.check.noTools.title",
      bodyKey: "status.check.noTools.body",
      section: "tools",
      sectionKey: "instances.detail.tabTools",
    });
  }

  /*
    A pinned skill keeps serving the version it was pinned to. That is the point
    of pinning — and also how an agent quietly runs last quarter's instructions
    for a year, because nothing anywhere says a newer version exists.
  */
  const outdated = skills.filter(
    (s) => s.enabled && s.pinnedVersion && s.currentVersion && s.pinnedVersion !== s.currentVersion,
  );
  if (outdated.length > 0) {
    checks.push({
      id: "skills-outdated-pin",
      severity: "warning",
      titleKey: "status.check.skillsOutdated.title",
      bodyKey: "status.check.skillsOutdated.body",
      params: { count: outdated.length, names: outdated.map((s) => s.name).join(", ") },
      section: "skills",
      sectionKey: "instances.detail.tabSkills",
    });
  }

  /*
    A skill declares the tools its instructions rely on. If one of them is not
    among the served tools, the skill tells the model to do something it cannot
    do — which reads as the agent lying rather than as a missing tool.
  */
  const servedNames = new Set(tools.filter((t) => t.enabled).map((t) => t.name));
  const skillsWithoutTools = skills.filter(
    (s) => s.enabled && (s.requiredTools ?? []).some((name) => !servedNames.has(name)),
  );
  if (skillsWithoutTools.length > 0) {
    checks.push({
      id: "skills-missing-tools",
      severity: "warning",
      titleKey: "status.check.skillsMissingTools.title",
      bodyKey: "status.check.skillsMissingTools.body",
      params: {
        count: skillsWithoutTools.length,
        names: skillsWithoutTools.map((s) => s.name).join(", "),
      },
      section: "tools",
      sectionKey: "instances.detail.tabTools",
    });
  }

  // ── Exposed ──────────────────────────────────────────────────────────

  /*
    Debug stores the full payload of every turn, PII included. Enterprise pairs
    this with its retention policy — where "on, and nothing is ever deleted" is a
    single, worse row — but retention is an Enterprise feature, so here the switch
    stands on its own.
  */
  if (instance.debugEnabled) {
    checks.push({
      id: "debug-enabled",
      severity: "warning",
      titleKey: "status.check.debug.title",
      bodyKey: "status.check.debug.body",
      section: "params",
      sectionKey: "instances.detail.tabParams",
    });
  }

  if (!instance.authEnabled) {
    // A2A raises the same missing auth from a warning to a break: the endpoint
    // drives full turns, and `a2a.controller.ts` already logs this where nobody
    // reads it.
    checks.push(
      instance.a2aEnabled
        ? {
            id: "a2a-open",
            severity: "broken",
            titleKey: "status.check.a2aOpen.title",
            bodyKey: "status.check.a2aOpen.body",
            section: "channels",
            sectionKey: "instances.detail.tabChannels",
          }
        : {
            id: "api-open",
            // Broken, not a warning: an open endpoint that spends the budget and
            // answers as the agent is not a thing to look at later.
            severity: "broken",
            titleKey: "status.check.apiOpen.title",
            bodyKey: "status.check.apiOpen.body",
            section: "channels",
            sectionKey: "instances.detail.tabChannels",
          },
    );
  }


  /*
    The opt-out switch is not a preference: `evaluateOptout` returns `pass`
    without consulting the list when it is off, so everyone who asked to be left
    alone is written to again. Broken, and the only check here about a promise
    made to a person rather than to the operator.
  */
  if (!instance.optoutEnabled && optedOutCount !== null && optedOutCount > 0) {
    checks.push({
      id: "optout-off-with-contacts",
      severity: "broken",
      titleKey: "status.check.optOutIgnored.title",
      bodyKey: "status.check.optOutIgnored.body",
      params: { count: optedOutCount },
      section: "privacy",
      sectionKey: "instances.detail.tabPrivacy",
    });
  }

  if (recentOptOuts !== null && recentOptOuts >= OPT_OUT_ALERT_THRESHOLD) {
    checks.push({
      id: "opt-outs-rising",
      severity: "warning",
      titleKey: "status.check.optOuts.title",
      bodyKey: "status.check.optOuts.body",
      params: { count: recentOptOuts },
      section: "privacy",
      sectionKey: "instances.detail.tabPrivacy",
    });
  }


  return sortBySeverity(checks);
}

const SEVERITY_ORDER: Record<CheckSeverity, number> = { broken: 0, warning: 1, note: 2 };

/** Worst first; within a severity, registry order — which groups by subject. */
function sortBySeverity(checks: AgentCheck[]): AgentCheck[] {
  return [...checks].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * The one-line verdict above the list.
 *
 * Notes do NOT count: they are true things that are usually deliberate, and an
 * agent reading "richiede attenzione" because it has no tools would teach its
 * reader to ignore the banner.
 */
export function statusVerdict(checks: AgentCheck[]): "ok" | "warning" | "broken" {
  if (checks.some((c) => c.severity === "broken")) return "broken";
  if (checks.some((c) => c.severity === "warning")) return "warning";
  return "ok";
}
