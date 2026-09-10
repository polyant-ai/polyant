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
 * Marker for the one scope that spans every tenant. It is a `Symbol` for the
 * same reason `SYSTEM_SCOPE` was: a symbol can never be produced by JSON body
 * or query-string parsing, so no HTTP input can widen a tenancy filter. A plain
 * `{ allTenants: true }` would have been forgeable by any request that guessed
 * the field name.
 */
export const ALL_TENANTS = Symbol("tenant-scope:all-tenants");

/**
 * Which tenant a store call acts in. Every variant has to be WRITTEN: there is
 * no absent member and no `undefined`, so "every tenant in the deployment" can
 * only be asked for on purpose, and a caller that has no scope in hand cannot
 * satisfy the type by passing nothing.
 *
 * The predicate that consumes this fails CLOSED by construction: the only
 * variant that emits no constraint is `allTenants`, which carries the reason it
 * is allowed to. `reason` is not decoration — it is what separates "this job
 * really does run across tenants" (boot, the retention sweep, a platform-admin
 * total) from "the caller had nothing to pass", which is the ambiguity a bare
 * `undefined` left behind at every call site.
 *
 * `workspaceId` / `workspaceIds` are declared here, in the shared file, even
 * though this build has a single workspace and produces neither: an
 * organization-only union would have to be widened in the enterprise build,
 * i.e. the same declaration reconciled at every merge, on the one file where a
 * silent revert changes who can read whose rows.
 */
export type TenantScope =
  | { readonly organizationId: string }
  | { readonly workspaceId: string }
  | { readonly workspaceIds: ReadonlySet<string> }
  | { readonly allTenants: typeof ALL_TENANTS; readonly reason: string };

/**
 * The scope of one organization. This is the constructor a request path uses,
 * after the caller's organization has been resolved — never with a raw id read
 * off a body, a query param or a token claim.
 *
 * INTERNAL USE: producing a `TenantScope` is a tenancy decision, so the call
 * belongs to whoever resolved the tenant, not to a store or a controller
 * helper reaching for it late.
 */
export function orgScope(organizationId: string): TenantScope {
  return { organizationId };
}

/** The scope of one workspace. Produced only where a workspace is authoritative. */
export function workspaceScope(workspaceId: string): TenantScope {
  return { workspaceId };
}

/**
 * The scope of a set of workspaces. An EMPTY set is a caller who can reach no
 * workspace, and it stays fail-closed: it is not a shortcut for "all".
 */
export function workspaceSetScope(workspaceIds: ReadonlySet<string>): TenantScope {
  return { workspaceIds };
}

/**
 * The scope that spans every tenant, for a caller that genuinely has none: boot
 * registering the channel adapters, the retention sweep over due policies, a
 * platform-admin total. `reason` is recorded in the call, so review can tell an
 * intended cross-tenant read from a missing argument.
 */
export function allTenantsScope(reason: string): TenantScope {
  return { allTenants: ALL_TENANTS, reason };
}

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
 * The predicate a `TenantScope` narrows to, or `null` for the one variant that
 * narrows to nothing. `null` is reachable ONLY from `allTenants`: every other
 * variant produces a constraint, and an empty workspace set produces `false`
 * rather than "no constraint", because a caller who can reach no workspace can
 * read no row.
 */
function scopedAgentPredicate(scope: TenantScope, columnName: OrgScopedAgentColumn): SQL | null {
  const column = columnFragment(columnName);
  if ("allTenants" in scope) return null;
  if ("organizationId" in scope) {
    return buildOrgScopedAgentFilter(scope.organizationId, columnName);
  }
  if ("workspaceId" in scope) {
    return sql`${column} in (
      select i.slug
      from instances i
      where i.workspace_id = ${scope.workspaceId}
    )`;
  }
  if (scope.workspaceIds.size === 0) return sql`false`;
  const ids = sql.join(
    [...scope.workspaceIds].map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`${column} in (
    select i.slug
    from instances i
    where i.workspace_id in (${ids})
  )`;
}

/**
 * Raw-SQL convenience: the scope's predicate prefixed with `AND`. Mirrors
 * `instanceFilter` so the raw-SQL stores (conversations, analytics, audit) can
 * append it next to their other `AND ...` fragments without branching.
 *
 * The scope is REQUIRED and cannot be empty. It used to be `orgId: string |
 * undefined`, and before that the absent branch returned an EMPTY fragment —
 * no constraint at all — justified as "in single-org OSS that degrades to no
 * extra constraint, preserving today's behavior". The problem with a fail-open
 * default in a tenancy filter is not what it does today, it is what it does the
 * day something reaches it: a principal with no organization (a legacy JWT, or
 * any gateway-forwarded identity, which never carries one) would read
 * analytics, conversations, audit logs and memories across every organization.
 * Only `PermissionGuard` denying an unresolved scope stood between that and a
 * request — one `@AuthenticatedOnly()` away from mattering.
 *
 * Then the absent branch became `and false`, which was honest but still let a
 * caller reach the wrong answer by forgetting an argument. Now there is no
 * absent branch to reach: a caller with no tenant in hand has to say
 * `allTenantsScope("why")`, which is a sentence someone can disagree with in
 * review.
 */
export function buildOrgScopedAgentFilterFragment(
  scope: TenantScope,
  columnName: OrgScopedAgentColumn = "instance_id",
): SQL {
  const predicate = scopedAgentPredicate(scope, columnName);
  if (predicate === null) return sql``;
  return sql`and ${predicate}`;
}

/**
 * The same predicate as a Drizzle condition, for the query-builder paths
 * (`and(..., cond)`). Always returns a condition — never `undefined` — so it
 * cannot be dropped by a `.filter(Boolean)` on the way into the query.
 */
export function tenantScopedAgentCondition(
  scope: TenantScope,
  columnName: OrgScopedAgentColumn = "instance_id",
): SQL {
  const predicate = scopedAgentPredicate(scope, columnName);
  if (predicate === null) return sql`true`;
  return predicate;
}
