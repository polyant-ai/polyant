// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The three answers this resolver can give, because a cap that resolves wrong in
 * the permissive direction is unbounded writes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn() }));

vi.mock("../database/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({ where: () => ({ limit: mockLimit }) }),
        }),
      }),
    }),
  },
}));

vi.mock("../config.js", () => ({
  config: { knowledge: { maxDocsPerInstance: 500 } },
}));

import { resolveKnowledgeDocCap } from "./doc-cap.js";
import { asInstanceSlug } from "../instances/identifiers.js";

const AGENT = asInstanceSlug("acme-bot");

describe("resolveKnowledgeDocCap", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should_use_the_organizations_own_cap_when_it_declares_one", async () => {
    mockLimit.mockResolvedValue([{ cap: 2000 }]);

    expect(await resolveKnowledgeDocCap(AGENT)).toBe(2000);
  });

  it("should_let_an_organization_raise_the_cap_above_the_deployment_default", async () => {
    // The env var is the DEFAULT, not a ceiling: an entitlement that could only
    // be lowered from the environment would still need a redeploy to sell.
    mockLimit.mockResolvedValue([{ cap: 10_000 }]);

    expect(await resolveKnowledgeDocCap(AGENT)).toBeGreaterThan(500);
  });

  it("should_fall_back_to_the_deployment_default_when_the_organization_declares_none", async () => {
    mockLimit.mockResolvedValue([{ cap: null }]);

    expect(await resolveKnowledgeDocCap(AGENT)).toBe(500);
  });

  it("should_fail_closed_to_the_deployment_default_for_an_agent_that_resolves_to_nothing", async () => {
    // A slug with no row, or a row whose workspace is gone. The other reading of
    // an unresolvable agent is "no limit", which is the wrong direction.
    mockLimit.mockResolvedValue([]);

    expect(await resolveKnowledgeDocCap(AGENT)).toBe(500);
  });
});
