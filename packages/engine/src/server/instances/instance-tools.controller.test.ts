// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The write-side tenancy gate of `PATCH /api/instances/:slug/tools`.
 *
 * The `tools` catalog is deployment-global: it holds one `agent:{slug}` row per
 * agent that enabled its `agent` channel, across every organization. Resolving
 * a requested tool name against it unscoped let an org wire itself an `ask_`
 * handoff into another org's agent — cross-tenant execution, since the handoff
 * runs the target's whole pipeline. These tests pin the gate.
 */

vi.mock("../../database/client.js", () => ({ db: {}, queryClient: {} }));

const { agentsShareOrganization } = vi.hoisted(() => ({
  agentsShareOrganization: vi.fn(),
}));
vi.mock("../../authz/agent-tenancy.js", async (importOriginal) => {
  // Keep the real `agentToolTarget` (pure string parsing) — only the DB-backed
  // predicate is stubbed, so a mistake in prefix handling still fails here.
  const actual = await importOriginal<typeof import("../../authz/agent-tenancy.js")>();
  return { ...actual, agentsShareOrganization };
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { assertAgentTargetsAreSiblings } from "./instance-tools.controller.js";

describe("assertAgentTargetsAreSiblings", () => {
  beforeEach(() => {
    agentsShareOrganization.mockReset();
  });

  it("should_reject_when_an_agent_entry_targets_another_organization", async () => {
    agentsShareOrganization.mockResolvedValue(false);

    await expect(
      assertAgentTargetsAreSiblings("caller-agent", ["agent:victim-of-org-b"]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("should_accept_when_the_agent_entry_targets_a_tenant_sibling", async () => {
    agentsShareOrganization.mockResolvedValue(true);

    await expect(
      assertAgentTargetsAreSiblings("caller-agent", ["agent:sibling"]),
    ).resolves.toBeUndefined();
    expect(agentsShareOrganization).toHaveBeenCalledWith("caller-agent", "sibling");
  });

  it("should_not_query_tenancy_for_ordinary_tools", async () => {
    await expect(
      assertAgentTargetsAreSiblings("caller-agent", ["webSearch", "readFile"]),
    ).resolves.toBeUndefined();
    expect(agentsShareOrganization).not.toHaveBeenCalled();
  });

  it("should_reject_the_whole_batch_when_one_entry_of_many_is_cross_org", async () => {
    agentsShareOrganization.mockImplementation(
      async (_caller: string, target: string) => target === "sibling",
    );

    await expect(
      assertAgentTargetsAreSiblings("caller-agent", [
        "webSearch",
        "agent:sibling",
        "agent:victim-of-org-b",
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("should_not_reveal_whether_a_rejected_target_exists", async () => {
    agentsShareOrganization.mockResolvedValue(false);

    // Same message for "no such agent" and "another tenant's agent": the
    // endpoint must not be an existence oracle for other orgs' slugs.
    const messages: string[] = [];
    for (const name of ["agent:ghost", "agent:victim-of-org-b"]) {
      await assertAgentTargetsAreSiblings("caller-agent", [name]).catch(
        (e: BadRequestException) => messages.push(e.message.replace(name, "<slug>")),
      );
    }
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
  });
});
