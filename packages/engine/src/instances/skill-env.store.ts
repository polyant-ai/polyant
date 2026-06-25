// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { agentSkillEnv } from "./skill-env.schema.js";
import { encrypt, decrypt } from "../crypto/index.js";
import { resolveAgentId } from "./resolve-agent-id.js";
import { type AgentSlug, type AgentUuid } from "./identifiers.js";

export async function setSkillEnv(params: {
  agentId: AgentUuid;
  skillSlug: string;
  key: string;
  value: string;
  sensitive: boolean;
}): Promise<void> {
  const storedValue = params.sensitive ? encrypt(params.value) : params.value;
  await db
    .insert(agentSkillEnv)
    .values({
      agentId: params.agentId,
      skillSlug: params.skillSlug,
      key: params.key,
      value: storedValue,
      encrypted: params.sensitive,
    })
    .onConflictDoUpdate({
      target: [agentSkillEnv.agentId, agentSkillEnv.skillSlug, agentSkillEnv.key],
      set: { value: storedValue, encrypted: params.sensitive, updatedAt: new Date() },
    });
}

/**
 * Get all decrypted env vars for a skill.
 * Accepts instance slug (e.g. "default"), resolves to UUID internally.
 */
export async function getSkillEnv(
  instanceSlug: AgentSlug,
  skillSlug: string,
): Promise<Record<string, string>> {
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return {};

  const rows = await db
    .select({ key: agentSkillEnv.key, value: agentSkillEnv.value, encrypted: agentSkillEnv.encrypted })
    .from(agentSkillEnv)
    .where(and(eq(agentSkillEnv.agentId, agentId), eq(agentSkillEnv.skillSlug, skillSlug)));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.encrypted ? decrypt(row.value) : row.value;
  }
  return result;
}

/**
 * Check if all required env keys exist for a skill.
 * Accepts instance slug (e.g. "default"), resolves to UUID internally.
 */
export async function hasAllRequiredEnv(
  instanceSlug: AgentSlug,
  skillSlug: string,
  keys: string[],
): Promise<boolean> {
  if (keys.length === 0) return true;
  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) return false;

  const rows = await db
    .select({ key: agentSkillEnv.key })
    .from(agentSkillEnv)
    .where(and(eq(agentSkillEnv.agentId, agentId), eq(agentSkillEnv.skillSlug, skillSlug)));
  const existing = new Set(rows.map((r) => r.key));
  return keys.every((k) => existing.has(k));
}

/**
 * Batch check: for multiple skills at once, check whether all required env keys exist.
 * Single DB query instead of N separate queries.
 * Returns a Map<skillSlug, boolean>.
 */
export async function hasAllRequiredEnvBatch(
  instanceSlug: AgentSlug,
  checks: Array<{ skillSlug: string; keys: string[] }>,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();

  // Skills with no keys are always satisfied
  const needsCheck = checks.filter((c) => {
    if (c.keys.length === 0) { result.set(c.skillSlug, true); return false; }
    return true;
  });

  if (needsCheck.length === 0) return result;

  const agentId = await resolveAgentId(instanceSlug);
  if (!agentId) {
    for (const c of needsCheck) result.set(c.skillSlug, false);
    return result;
  }

  // Single query: get all skill env rows for this instance
  const rows = await db
    .select({ skillSlug: agentSkillEnv.skillSlug, key: agentSkillEnv.key })
    .from(agentSkillEnv)
    .where(eq(agentSkillEnv.agentId, agentId));

  // Group existing keys by skill slug
  const existingBySkill = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = existingBySkill.get(row.skillSlug);
    if (!set) { set = new Set(); existingBySkill.set(row.skillSlug, set); }
    set.add(row.key);
  }

  for (const c of needsCheck) {
    const existing = existingBySkill.get(c.skillSlug);
    result.set(c.skillSlug, existing ? c.keys.every((k) => existing.has(k)) : false);
  }

  return result;
}

export async function deleteSkillEnv(
  agentId: AgentUuid,
  skillSlug: string,
  key: string,
): Promise<void> {
  await db
    .delete(agentSkillEnv)
    .where(
      and(
        eq(agentSkillEnv.agentId, agentId),
        eq(agentSkillEnv.skillSlug, skillSlug),
        eq(agentSkillEnv.key, key),
      ),
    );
}
