// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql, type SQL } from "drizzle-orm";

/**
 * Store-layer org-scoping (RBAC Stream 2 — release gate).
 *
 * Every tenant-scoped store keys its rows by the agent *slug* (the `instance_id`
 * text column on conversations, memories, pipeline_traces, tool_audit_logs).
 * An agent belongs to exactly one workspace, and a workspace to exactly one
 * organization (`instances.workspace_id -> workspaces.organization_id`).
 *
 * `buildOrgScopedAgentFilter(orgId)` returns a predicate that restricts the slug
 * column to the agents owned by the caller's organization:
 *
 *   instance_id IN (
 *     SELECT i.slug FROM instances i
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
  "instance_id",
  "c.instance_id",
  "al.instance_id",
  // The agents table itself (`instances.slug`), so the agent LIST endpoints scope
  // with the same membership definition instead of a second hand-rolled join.
  "slug",
] as const;

export type OrgScopedAgentColumn = (typeof ORG_SCOPED_AGENT_COLUMNS)[number];

const ALLOWED_COLUMNS = new Set<string>(ORG_SCOPED_AGENT_COLUMNS);

/**
 * Render `<column>` as a safe SQL identifier fragment. A bare `instance_id`
 * becomes `"instance_id"`; a qualified `c.instance_id` becomes
 * `"c"."instance_id"` so the predicate is usable inside aliased raw-SQL joins.
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
 * @param columnName the slug column to constrain (allowlisted; default `instance_id`).
 */
export function buildOrgScopedAgentFilter(
  orgId: string,
  columnName: OrgScopedAgentColumn = "instance_id",
): SQL {
  const column = columnFragment(columnName);
  return sql`${column} in (
    select i.slug
    from instances i
    join workspaces w on w.id = i.workspace_id
    where w.organization_id = ${orgId}
  )`;
}

/**
 * Raw-SQL convenience: the same predicate prefixed with `AND`. Mirrors
 * `instanceFilter` so the raw-SQL stores (conversations, analytics, audit) can
 * append it next to their other `AND ...` fragments without branching.
 *
 * FAILS CLOSED when `orgId` is absent. This used to return an EMPTY fragment —
 * i.e. no constraint at all — justified as "in single-org OSS that degrades to
 * no extra constraint, preserving today's behavior". The problem with a
 * fail-open default in a tenancy filter is not what it does today, it is what it
 * does the day something reaches it: a principal with no `orgId` claim (a legacy
 * JWT, or any gateway-forwarded identity, which never carries one) would read
 * analytics, conversations, audit logs and memories across every organization.
 * Only `PermissionGuard` denying an unresolved scope stood between that and a
 * request — one `@AuthenticatedOnly()` away from mattering.
 *
 * `and false` is the honest translation of "this caller has no organization, so
 * no agent belongs to it". Callers that must serve an org-less principal have to
 * say so explicitly rather than inheriting it from a missing argument.
 */
export function buildOrgScopedAgentFilterFragment(
  orgId: string | undefined,
  columnName: OrgScopedAgentColumn = "instance_id",
): SQL {
  if (!orgId) return sql`and false`;
  return sql`and ${buildOrgScopedAgentFilter(orgId, columnName)}`;
}
