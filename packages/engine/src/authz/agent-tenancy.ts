// SPDX-License-Identifier: AGPL-3.0-or-later

import { readAgentScope } from "./authz.store.js";

/**
 * Whether two agents belong to the same organization.
 *
 * This is the predicate behind every agent→agent capability. An
 * `agent:{slug}` entry in `instance_tools` makes the supervisor synthesise an
 * `ask_{slug}` tool, which opens a live channel into the target's full
 * pipeline — its prompt, knowledge base, secrets and tools all execute for the
 * caller. Granting that across a tenant boundary is cross-tenant code
 * execution, not a read, so both the write path (the tools API) and the
 * enforcement point (the supervisor) gate on this.
 *
 * An unknown agent on either side resolves to no scope and returns `false`:
 * fail-closed, so a dangling catalog row never widens access.
 */
export async function agentsShareOrganization(
  callerSlug: string,
  targetSlug: string,
): Promise<boolean> {
  if (callerSlug === targetSlug) return true;
  const [caller, target] = await Promise.all([
    readAgentScope(callerSlug),
    readAgentScope(targetSlug),
  ]);
  return (
    caller !== null &&
    target !== null &&
    caller.organizationId === target.organizationId
  );
}

/** The `agent:{slug}` tool-catalog naming convention, in one place. */
export const AGENT_TOOL_PREFIX = "agent:";

/** The target agent slug of an `agent:{slug}` entry, or `null` for other tools. */
export function agentToolTarget(toolName: string): string | null {
  return toolName.startsWith(AGENT_TOOL_PREFIX)
    ? toolName.slice(AGENT_TOOL_PREFIX.length)
    : null;
}
