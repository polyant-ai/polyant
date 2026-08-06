// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the agent→agent tenancy predicate. An `agent:{slug}` tool
 * entry grants the caller a live handoff into the target's whole pipeline, so
 * this predicate is the boundary that keeps that capability inside one tenant.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
vi.mock("../database/client.js", () => ({ db: {}, queryClient: {} }));

const { readAgentScope } = vi.hoisted(() => ({ readAgentScope: vi.fn() }));
vi.mock("./authz.store.js", () => ({ readAgentScope }));

import {
  agentsShareOrganization,
  agentToolTarget,
  AGENT_TOOL_PREFIX,
} from "./agent-tenancy.js";

const scope = (organizationId: string) => ({
  agentId: `id-${organizationId}`,
  workspaceId: `ws-${organizationId}`,
  organizationId,
});

describe("agentToolTarget", () => {
  it("should_extract_the_slug_when_the_name_is_an_agent_entry", () => {
    expect(agentToolTarget(`${AGENT_TOOL_PREFIX}helper-bot`)).toBe("helper-bot");
  });

  it("should_return_null_when_the_name_is_an_ordinary_tool", () => {
    expect(agentToolTarget("webSearch")).toBeNull();
    // A tool whose name merely CONTAINS the prefix is not an agent entry.
    expect(agentToolTarget("myagent:thing")).toBeNull();
  });
});

describe("agentsShareOrganization", () => {
  beforeEach(() => {
    readAgentScope.mockReset();
  });

  it("should_allow_when_both_agents_are_in_the_same_org", async () => {
    readAgentScope.mockResolvedValue(scope("org-1"));
    await expect(agentsShareOrganization("caller", "target")).resolves.toBe(true);
  });

  it("should_deny_when_the_target_is_in_another_org", async () => {
    readAgentScope.mockImplementation(async (slug: string) =>
      slug === "caller" ? scope("org-1") : scope("org-2"),
    );
    await expect(agentsShareOrganization("caller", "target")).resolves.toBe(false);
  });

  it("should_deny_when_the_target_does_not_exist", async () => {
    readAgentScope.mockImplementation(async (slug: string) =>
      slug === "caller" ? scope("org-1") : null,
    );
    await expect(agentsShareOrganization("caller", "ghost")).resolves.toBe(false);
  });

  it("should_deny_when_the_caller_itself_has_no_resolvable_scope", async () => {
    readAgentScope.mockResolvedValue(null);
    await expect(agentsShareOrganization("orphan", "target")).resolves.toBe(false);
  });

  it("should_short_circuit_without_a_query_when_caller_and_target_are_the_same", async () => {
    await expect(agentsShareOrganization("same", "same")).resolves.toBe(true);
    expect(readAgentScope).not.toHaveBeenCalled();
  });
});
