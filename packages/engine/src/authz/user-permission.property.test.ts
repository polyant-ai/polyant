// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decideUserPermission } from "./user-permission.js";
import { Permission, type PermissionKey } from "./permissions.js";
import type { AgentScope } from "./authz.store.js";

/*
  Tenant isolation of the shared user decision. Whatever the role bindings say
  (`can` is generated, true or false), a caller signed into one organization is
  never allowed to act on an agent of another one; only a Platform Admin
  crosses organizations. The expected verdict is written from the generated
  inputs, not from the function.
*/

const ORG = fc.constantFrom("org-a", "org-b", "org-c");
const CASE = fc.record({
  platformAdmin: fc.boolean(),
  can: fc.boolean(),
  principalOrg: fc.option(ORG, { nil: undefined }),
  agentSlug: fc.option(fc.constantFrom("agent-1", "agent-2"), { nil: undefined }),
  agentOrg: fc.option(ORG, { nil: null }),
  addressed: fc.boolean(),
  permission: fc.constantFrom(...(Object.values(Permission) as PermissionKey[])),
});

describe("decideUserPermission (property)", () => {
  it("never allows a non-Platform-Admin to act across organizations, whatever the bindings grant", async () => {
    await fc.assert(
      fc.asyncProperty(CASE, async (c) => {
        const agentScope: AgentScope | null = c.agentOrg
          ? { agentId: "agent-id", workspaceId: "ws", organizationId: c.agentOrg }
          : null;
        const asked: AgentScope[] = [];
        const authz = {
          isPlatformAdmin: async () => c.platformAdmin,
          resolveAgentScope: async () => agentScope,
          can: async (_user: string, scope: AgentScope) => {
            asked.push(scope);
            return c.can;
          },
        };

        const decision = await decideUserPermission(
          authz as never,
          { userId: "user", orgId: c.principalOrg },
          c.permission,
          c.agentSlug,
          c.addressed && agentScope ? agentScope : undefined,
        );

        const targetOrg = c.agentSlug ? agentScope?.organizationId : c.principalOrg;
        const sameTenant =
          targetOrg !== undefined && (c.principalOrg === undefined || c.principalOrg === targetOrg);
        expect(decision.allowed).toBe(c.platformAdmin || (sameTenant && c.can));
        // The bindings are only ever consulted for the caller's own organization.
        if (c.principalOrg !== undefined) {
          for (const scope of asked) expect(scope.organizationId).toBe(c.principalOrg);
        }
      }),
      { numRuns: 400 },
    );
  });
});
