// SPDX-License-Identifier: AGPL-3.0-or-later

import { getSkillEnvEntries } from "../../../instances/skill-env.store.js";
import type { InstanceSlug } from "../../../instances/identifiers.js";

/**
 * Sensitive skill env, without the model ever holding it.
 *
 * `readSkill` used to interpolate decrypted values straight into its result, so
 * an operator's `crm_api_token` entered the conversation, the persisted history
 * and — via `safeOutputPreview` — `tool_audit_logs` in cleartext, defeating the
 * AES-256-GCM encryption those rows are stored under. It needed no attack: the
 * prompt tells the model to call `readSkill`.
 *
 * Instead the model gets `{{skill_env.<skill>.<KEY>}}`, an opaque token it can
 * move into a tool argument but cannot read, and `buildTool` swaps in the real
 * value between validation and `execute`. The plaintext therefore exists only
 * inside the tool call, never in anything that is logged or persisted.
 *
 * Qualified by SKILL because env is scoped per `(instance, skill)`: two skills
 * may legitimately define the same key name, and an unqualified placeholder
 * would let one skill's instructions reach another's credential.
 */
const PATTERN = String.raw`\{\{skill_env\.([a-z0-9][a-z0-9_-]*)\.([A-Za-z0-9_]+)\}\}`;

/** Fresh each time: a shared /g regex carries `lastIndex` between calls, which
 *  makes the second sweep of a turn silently skip what the first one matched. */
const re = () => new RegExp(PATTERN, "g");

/** Cheap pre-check so the overwhelming majority of tool calls pay a tree walk
 *  and no database query at all. */
export function hasPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return re().test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === "object") return Object.values(value).some(hasPlaceholder);
  return false;
}

function collectSkills(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(re())) out.add(m[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSkills(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSkills(item, out);
  }
}

function replaceIn(value: unknown, resolve: (skill: string, key: string) => string | undefined): unknown {
  if (typeof value === "string") {
    return value.replace(re(), (whole, skill: string, key: string) => resolve(skill, key) ?? whole);
  }
  if (Array.isArray(value)) return value.map((item) => replaceIn(item, resolve));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceIn(v, resolve);
    return out;
  }
  return value;
}

/**
 * Replace every `{{skill_env.<skill>.<KEY>}}` naming a SENSITIVE var of an
 * enabled skill with its decrypted value.
 *
 * Two deliberate non-actions. An unknown key is left verbatim rather than
 * emptied: `Authorization: Bearer ` produces a confusing 401, while the
 * untouched placeholder is a failure the model can read and report. And a
 * NON-sensitive key is left verbatim too — those are emitted inline by
 * `readSkill`, so a placeholder naming one is a model invention, and honouring
 * it would turn this function into an oracle for which keys exist.
 */
export async function substituteSkillEnv(
  value: unknown,
  instanceId: InstanceSlug,
): Promise<unknown> {
  const slugs = new Set<string>();
  collectSkills(value, slugs);
  if (slugs.size === 0) return value;

  // One query per SKILL, not per placeholder.
  const bySkill = new Map<string, Map<string, string>>();
  await Promise.all(
    [...slugs].map(async (slug) => {
      const entries = await getSkillEnvEntries(instanceId, slug);
      const sensitive = new Map<string, string>();
      for (const e of entries) if (e.sensitive) sensitive.set(e.key, e.value);
      bySkill.set(slug, sensitive);
    }),
  );

  return replaceIn(value, (skill, key) => bySkill.get(skill)?.get(key));
}
