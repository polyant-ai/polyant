// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildOrgScopedAgentFilter,
  buildOrgScopedAgentFilterFragment,
  ORG_SCOPED_AGENT_COLUMNS,
  orgScope,
  workspaceScope,
  workspaceSetScope,
  allTenantsScope,
  tenantScopedAgentCondition,
} from "./scope-filter.js";

const dialect = new PgDialect();

function render(fragment: ReturnType<typeof buildOrgScopedAgentFilter>) {
  return dialect.sqlToQuery(fragment);
}

describe("buildOrgScopedAgentFilter", () => {
  it("should_scope_to_agents_in_org_via_subquery_when_orgId_present", () => {
    const { sql: text } = render(buildOrgScopedAgentFilter("org-a"));
    // Restricts the slug column to agents owned by the org's workspaces.
    expect(text).toMatch(/"instance_id"\s+in\s*\(\s*select/i);
    expect(text).toContain("instances");
    expect(text).toContain("workspaces");
    expect(text).toContain("organization_id");
  });

  it("should_bind_orgId_as_a_parameter_not_interpolate_it", () => {
    const malicious = "x'; DROP TABLE instances;--";
    const { sql: text, params } = render(buildOrgScopedAgentFilter(malicious));
    // The org id must travel as a bound param, never inlined into the SQL text.
    expect(text).not.toContain(malicious);
    expect(params).toContain(malicious);
  });

  it("should_target_a_custom_qualified_column_when_provided", () => {
    const { sql: text } = render(
      buildOrgScopedAgentFilter("org-a", "c.instance_id"),
    );
    expect(text).toMatch(/"c"\."instance_id"\s+in\s*\(/i);
  });

  it("should_target_the_agents_table_own_slug_column_when_asked", () => {
    // Used by the agent LIST endpoints, whose FROM is `instances` itself: the
    // outer column is the unqualified `slug`, the subquery aliases its own copy
    // as `i`, so the reference stays unambiguous.
    const { sql: text, params } = render(buildOrgScopedAgentFilter("org-a", "slug"));
    expect(text).toMatch(/"slug"\s+in\s*\(\s*select\s+i\.slug/i);
    expect(params).toContain("org-a");
  });

  it("should_reject_a_column_outside_the_allowlist", () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard with a disallowed column.
      buildOrgScopedAgentFilter("org-a", "evil_column"),
    ).toThrow(/allowlist/i);
  });

  it("should_expose_the_allowlisted_columns", () => {
    expect(ORG_SCOPED_AGENT_COLUMNS).toContain("instance_id");
    expect(ORG_SCOPED_AGENT_COLUMNS).toContain("c.instance_id");
  });
});

describe("buildOrgScopedAgentFilterFragment", () => {
  it("should_prefix_with_AND_for_an_organization_scope", () => {
    const { sql: text, params } = render(
      buildOrgScopedAgentFilterFragment(orgScope("org-a")),
    );
    expect(text.trim().toUpperCase().startsWith("AND")).toBe(true);
    expect(text).toMatch(/"instance_id"\s+in\s*\(/i);
    expect(params).toContain("org-a");
  });

  /**
   * One case per variant, because the union is what makes the predicate safe.
   *
   * The case this replaces was `undefined`, which the type no longer admits: the
   * absent branch used to return an EMPTY fragment — no constraint at all — on
   * the reasoning that single-org OSS could not tell the difference. What it
   * actually meant is that a principal with no organization (a legacy JWT, or
   * any gateway-forwarded identity, which never carries one) read analytics,
   * conversations, audit logs and memories across EVERY organization, with only
   * PermissionGuard's unresolved-scope deny standing in front of it.
   *
   * What can still be got wrong is the two variants that look like "nothing":
   * an EMPTY workspace set (a caller who can reach no workspace) must match no
   * row, and `allTenants` must be the ONLY variant that constrains nothing.
   */
  it("should_constrain_the_slug_column_for_a_workspace_scope", () => {
    const { sql: text, params } = render(
      buildOrgScopedAgentFilterFragment(workspaceScope("ws-1")),
    );
    expect(text).toMatch(/workspace_id\s*=/i);
    expect(params).toContain("ws-1");
  });

  it("should_bind_every_id_for_a_workspace_set_scope", () => {
    const { sql: text, params } = render(
      buildOrgScopedAgentFilterFragment(workspaceSetScope(new Set(["ws-1", "ws-2"]))),
    );
    expect(text).toMatch(/workspace_id\s+in\s*\(/i);
    expect(params).toContain("ws-1");
    expect(params).toContain("ws-2");
  });

  it("should_match_nothing_for_a_caller_who_can_reach_no_workspace", () => {
    const { sql: text } = render(
      buildOrgScopedAgentFilterFragment(workspaceSetScope(new Set())),
    );
    expect(text.trim().toLowerCase()).toBe("and false");
  });

  it("should_constrain_nothing_ONLY_for_the_cross_tenant_scope", () => {
    const { sql: text } = render(
      buildOrgScopedAgentFilterFragment(allTenantsScope("a test that says why")),
    );
    expect(text.trim()).toBe("");
  });
});

describe("tenantScopedAgentCondition", () => {
  it("should_always_return_a_condition_so_it_cannot_be_filtered_out", () => {
    const forOrg = render(tenantScopedAgentCondition(orgScope("org-a")));
    expect(forOrg.sql.trim()).not.toBe("");
    // `true` rather than `undefined`: an undefined condition is silently dropped
    // by a `.filter(Boolean)` on the way into the query builder.
    const forAll = render(tenantScopedAgentCondition(allTenantsScope("a test that says why")));
    expect(forAll.sql.trim().toLowerCase()).toBe("true");
    const forNobody = render(tenantScopedAgentCondition(workspaceSetScope(new Set())));
    expect(forNobody.sql.trim().toLowerCase()).toBe("false");
  });
});
