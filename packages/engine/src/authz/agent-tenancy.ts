// SPDX-License-Identifier: AGPL-3.0-or-later

import { readAgentScope } from "./authz.store.js";
import { resolvePrincipalOrgId } from "../instances/store.js";
import { createLogger } from "../utils/create-logger.js";

const logger = createLogger();
const LOG_PREFIX = "authz";

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

/** The subset of a principal this check needs, from any auth source. */
export interface AgentAccessCaller {
  readonly kind?: string;
  readonly instanceSlug?: string;
  readonly orgId?: string;
}

/**
 * Whether `caller` may act on `agentSlug`, for a route where PermissionGuard
 * CANNOT decide it.
 *
 * The guard resolves an agent scope from `params.slug`. A route that names its
 * agent anywhere else — a request body, a query string, a segment of an S3 key —
 * therefore gets authorized at the caller's OWN org level, and nothing ties the
 * agent it addresses to the caller's tenancy. `POST /memories` was exactly that
 * shape: `agent.memory:write` at the caller's org, then `body.instanceId`
 * written verbatim into another tenant's agent, which for memories means durable
 * prompt injection into that agent's next turn.
 *
 * So any handler taking an agent identifier from outside `params.slug` must call
 * this. It is one function rather than a per-controller copy precisely because
 * the next such route will be written by someone who has not read this comment.
 *
 * Returns a boolean; the caller chooses the status. Prefer 404 over 403 on read
 * paths, so a caller of another organization cannot learn the agent exists.
 */
export async function callerMayAccessAgent(
  agentSlug: string,
  caller: AgentAccessCaller | undefined,
): Promise<boolean> {
  // A per-instance API key acts only for its own agent — the same rule
  // PermissionGuard applies to an instance principal on a `:slug` route. It
  // carries no org, so the slug alone decides.
  if (caller?.kind === "instance") {
    return caller.instanceSlug === agentSlug;
  }

  // Everyone else (human session, gateway identity, management API key) is
  // decided on the organization. `resolvePrincipalOrgId` is the shared rule: an
  // explicit claim wins; with no claim a single-org deployment is unambiguous;
  // anything else fails closed, because ownership is then unprovable.
  const orgId = await resolvePrincipalOrgId(caller?.orgId);
  if (!orgId) return false;

  try {
    const scope = await readAgentScope(agentSlug);
    // Unknown agent and foreign agent are deliberately indistinguishable.
    return scope?.organizationId === orgId;
  } catch (err) {
    // Fail closed on a lookup failure rather than acting unverified.
    logger.error(LOG_PREFIX, `agent scope lookup failed for "${agentSlug}"`, err);
    return false;
  }
}

/** The `agent:{slug}` tool-catalog naming convention, in one place. */
export const AGENT_TOOL_PREFIX = "agent:";

/** The target agent slug of an `agent:{slug}` entry, or `null` for other tools. */
export function agentToolTarget(toolName: string): string | null {
  return toolName.startsWith(AGENT_TOOL_PREFIX)
    ? toolName.slice(AGENT_TOOL_PREFIX.length)
    : null;
}
