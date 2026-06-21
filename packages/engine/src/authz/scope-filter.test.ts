// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildOrgScopedAgentFilter,
  buildOrgScopedAgentFilterFragment,
  ORG_SCOPED_AGENT_COLUMNS,
} from "./scope-filter.js";

const dialect = new PgDialect();

function render(fragment: ReturnType<typeof buildOrgScopedAgentFilter>) {
  return dialect.sqlToQuery(fragment);
}

describe("buildOrgScopedAgentFilter", () => {
  it("should_scope_to_agents_in_org_via_subquery_when_orgId_present", () => {
    const { sql: text } = render(buildOrgScopedAgentFilter("org-a"));
    // Restricts the slug column to agents owned by the org's workspaces.
    expect(text).toMatch(/"agent_id"\s+in\s*\(\s*select/i);
    expect(text).toContain("agents");
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
      buildOrgScopedAgentFilter("org-a", "c.agent_id"),
    );
    expect(text).toMatch(/"c"\."agent_id"\s+in\s*\(/i);
  });

  it("should_reject_a_column_outside_the_allowlist", () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard with a disallowed column.
      buildOrgScopedAgentFilter("org-a", "evil_column"),
    ).toThrow(/allowlist/i);
  });

  it("should_expose_the_allowlisted_columns", () => {
    expect(ORG_SCOPED_AGENT_COLUMNS).toContain("agent_id");
    expect(ORG_SCOPED_AGENT_COLUMNS).toContain("c.agent_id");
  });
});

describe("buildOrgScopedAgentFilterFragment", () => {
  it("should_prefix_with_AND_when_orgId_present", () => {
    const { sql: text, params } = render(
      buildOrgScopedAgentFilterFragment("org-a"),
    );
    expect(text.trim().toUpperCase().startsWith("AND")).toBe(true);
    expect(text).toMatch(/"agent_id"\s+in\s*\(/i);
    expect(params).toContain("org-a");
  });

  it("should_be_empty_when_orgId_is_undefined", () => {
    const { sql: text } = render(buildOrgScopedAgentFilterFragment(undefined));
    expect(text.trim()).toBe("");
  });
});
