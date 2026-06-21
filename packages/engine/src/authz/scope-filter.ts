// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type SQL } from "drizzle-orm";

/**
 * Store-layer org-scoping (RBAC Stream 2 — release gate).
 *
 * Every tenant-scoped store keys its rows by the agent *slug* (the `agent_id`
 * text column on conversations, memories, pipeline_traces, tool_audit_logs).
 * An agent belongs to exactly one workspace, and a workspace to exactly one
 * organization (`instances.workspace_id -> workspaces.organization_id`).
 *
 * `buildOrgScopedAgentFilter(orgId)` returns a predicate that restricts the slug
 * column to the agents owned by the caller's organization:
 *
 *   agent_id IN (
 *     SELECT i.slug FROM agents i
 *     JOIN workspaces w ON w.id = i.workspace_id
 *     WHERE w.organization_id = <orgId>
 *   )
 *
 * Applied (AND-ed) in every list/read path it closes BOTH cross-org leak vectors
 * at the store layer rather than the guard:
 *  - param-IDOR: an Org-A caller passing an Org-B `instanceId` query param gets
 *    zero rows, because the foreign slug is not in the org subquery.
 *  - aggregate leak: an aggregate list with no `instanceId` returns only the
 *    caller-org rows, never the whole deployment.
 *
 * The `orgId` always travels as a bound parameter (never string-interpolated),
 * so a hostile org id cannot inject SQL.
 */

/**
 * Slug columns the filter is allowed to constrain. Restricting the column name
 * to a literal allowlist keeps `sql.raw()` (used to qualify the column) free of
 * any caller-controlled text. Mirrors `utils/query-helpers.ts` `instanceFilter`.
 */
export const ORG_SCOPED_AGENT_COLUMNS = [
  "agent_id",
  "c.agent_id",
  "al.agent_id",
] as const;

export type OrgScopedAgentColumn = (typeof ORG_SCOPED_AGENT_COLUMNS)[number];

const ALLOWED_COLUMNS = new Set<string>(ORG_SCOPED_AGENT_COLUMNS);

/**
 * Render `<column>` as a safe SQL identifier fragment. A bare `agent_id`
 * becomes `"agent_id"`; a qualified `c.agent_id` becomes
 * `"c"."agent_id"` so the predicate is usable inside aliased raw-SQL joins.
 */
function columnFragment(columnName: OrgScopedAgentColumn): SQL {
  if (!ALLOWED_COLUMNS.has(columnName)) {
    throw new Error(`scope-filter: column "${columnName}" is not in the allowlist`);
  }
  const quoted = columnName
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
  return sql.raw(quoted);
}

/**
 * Build the `<column> IN (org subquery)` predicate for a known organization.
 *
 * Usable both inside the Drizzle query builder (`and(..., filter)`) and embedded
 * inside a raw `sql\`...\`` block — a Drizzle `SQL` value composes in both.
 *
 * @param orgId      the caller's resolved organization id (bound parameter).
 * @param columnName the slug column to constrain (allowlisted; default `agent_id`).
 */
export function buildOrgScopedAgentFilter(
  orgId: string,
  columnName: OrgScopedAgentColumn = "agent_id",
): SQL {
  const column = columnFragment(columnName);
  return sql`${column} in (
    select i.slug
    from agents i
    join workspaces w on w.id = i.workspace_id
    where w.organization_id = ${orgId}
  )`;
}

/**
 * Raw-SQL convenience: the same predicate prefixed with `AND`, or an empty
 * fragment when `orgId` is absent. Mirrors `instanceFilter` so the existing
 * raw-SQL stores (conversations, analytics, audit) can append it next to the
 * other `AND ...` fragments without branching.
 *
 * `orgId` is optional because legacy JWTs minted before the claim existed (and
 * gateway-forwarded identities) carry none — in single-org OSS that degrades to
 * "no extra constraint", preserving today's behavior. Multi-org callers always
 * pass an `orgId`, so the cross-org gate is enforced.
 */
export function buildOrgScopedAgentFilterFragment(
  orgId: string | undefined,
  columnName: OrgScopedAgentColumn = "agent_id",
): SQL {
  if (!orgId) return sql``;
  return sql`and ${buildOrgScopedAgentFilter(orgId, columnName)}`;
}
