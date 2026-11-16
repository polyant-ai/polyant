// SPDX-License-Identifier: AGPL-3.0-or-later

import { NO_TRANSACTION } from "../database/client.js";
import { isUniqueViolation } from "../utils/db-errors.js";
import { asInstanceSlug } from "./identifiers.js";
import { assertModelConfig } from "./instance-update.js";
import { createInstanceWithDefaults, resolvePrincipalOrgId, type Instance } from "./store.js";

/**
 * Why an agent was not created, worded for the caller. `conflict` is a taken
 * slug; `invalid` is anything the caller can fix in the request.
 */
export class AgentCreateRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid" | "conflict",
  ) {
    super(message);
    this.name = "AgentCreateRefusedError";
  }
}

const SLUG_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;

/**
 * What is wrong with an agent slug, or null when it is fine. The length bound
 * is the column's (varchar(100)), so an over-long slug is a refusal rather
 * than a database error.
 */
export function agentSlugProblem(slug: unknown): string | null {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 100) {
    return "Invalid slug: must be 1-100 characters.";
  }
  if (!SLUG_RE.test(slug)) {
    return 'Invalid slug format. Use lowercase alphanumeric, hyphens, or underscores (e.g. "my-assistant").';
  }
  return null;
}

export interface CreateAgentInput {
  slug: string;
  name: string;
  description?: string;
  provider?: string;
  model?: string;
}

export interface CreateAgentCaller {
  /** The organization claim of the caller, if it carries one. */
  orgId?: string;
  /** The workspace the caller addresses; the organization default when absent. */
  workspaceSlug?: string;
}

/**
 * Create an agent with its default prompt, tools and skills, in the caller's
 * organization. The single path for every caller that creates an agent, so
 * every caller refuses the same inputs the same way.
 * Authorization (`agent:write`) is the caller's to check first.
 */
export async function createAgent(input: CreateAgentInput, caller: CreateAgentCaller): Promise<Instance> {
  const slugProblem = agentSlugProblem(input.slug);
  if (slugProblem) throw new AgentCreateRefusedError(slugProblem, "invalid");
  try {
    assertModelConfig(input.provider, input.model);
  } catch (err) {
    throw new AgentCreateRefusedError(err instanceof Error ? err.message : "Invalid model settings.", "invalid");
  }
  // The store fails closed on an unresolvable organization; that is a
  // caller-side condition (a principal with no org claim on a multi-org
  // deployment), not a server fault.
  const orgId = await resolvePrincipalOrgId(caller.orgId, NO_TRANSACTION);
  if (!orgId) {
    throw new AgentCreateRefusedError(
      "Cannot resolve the caller's organization — the agent has no workspace to be created in.",
      "invalid",
    );
  }
  try {
    // `orgId` last: it comes from the authenticated principal and must never be
    // overridable by a field of the input. The workspace is validated against
    // `orgId` inside the store. Atomic: the agent row and its prompt / tool /
    // skill seeds land together or not at all. The unique constraint is the
    // duplicate check; a pre-select would race.
    return await createInstanceWithDefaults({
      ...input,
      slug: asInstanceSlug(input.slug),
      orgId,
      workspaceSlug: caller.workspaceSlug,
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      throw new AgentCreateRefusedError(`Slug "${input.slug}" already exists`, "conflict");
    }
    // An addressed workspace that is not the caller's own: the agent is
    // deliberately NOT filed under the organization default instead.
    if (err instanceof Error && err.message.includes("does not belong to the caller")) {
      throw new AgentCreateRefusedError(err.message, "invalid");
    }
    throw err;
  }
}
