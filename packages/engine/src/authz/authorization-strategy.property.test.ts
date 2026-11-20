// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { effectivePermissions, resolvePermission } from "./authorization-strategy.js";
import { Permission, type PermissionKey } from "./permissions.js";
import type { AgentScope, EffectiveBinding } from "./authz.store.js";

/*
  Properties of the binding evaluator. The expected set never comes from the
  evaluator: the generator builds the user's bindings out of three labelled
  parts (the target workspace's binding, the target organization's binding, and
  bindings on OTHER scopes), so the answer is known by construction:
  workspace binding if present, else organization binding, else nothing.
*/

const CATALOGUE = Object.values(Permission) as PermissionKey[];

// A small id pool so foreign bindings often share an id with the target under
// the other scope type (a workspace binding whose id equals the organization's,
// and the reverse): a match on id alone would then leak.
const ID = fc.constantFrom("id-a", "id-b", "id-c", "id-d");
const PERMISSIONS = fc.subarray(CATALOGUE).map((p) => new Set(p) as ReadonlySet<PermissionKey>);
const SCOPE_TYPE = fc.constantFrom("organization", "workspace") as fc.Arbitrary<"organization" | "workspace">;

function isTarget(b: Pick<EffectiveBinding, "scopeType" | "scopeId">, scope: AgentScope): boolean {
  return (
    (b.scopeType === "workspace" && b.scopeId === scope.workspaceId) ||
    (b.scopeType === "organization" && b.scopeId === scope.organizationId)
  );
}

const CASE = fc
  .record({
    scope: fc.record({ agentId: fc.constant("agent"), workspaceId: ID, organizationId: ID }),
    own: fc.record({
      workspace: fc.option(PERMISSIONS, { nil: undefined }),
      organization: fc.option(PERMISSIONS, { nil: undefined }),
    }),
    foreign: fc.array(fc.record({ scopeType: SCOPE_TYPE, scopeId: ID, permissions: PERMISSIONS }), {
      maxLength: 6,
    }),
  })
  .chain(({ scope, own, foreign }) => {
    // One binding per (scope type, scope id): the shape the writers maintain
    // (they delete a user's scope bindings before inserting the new one).
    const seen = new Set<string>();
    const others = foreign.filter((b) => {
      const key = `${b.scopeType}:${b.scopeId}`;
      if (isTarget(b, scope) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const all: EffectiveBinding[] = [...others];
    if (own.workspace) all.push({ scopeType: "workspace", scopeId: scope.workspaceId, permissions: own.workspace });
    if (own.organization) {
      all.push({ scopeType: "organization", scopeId: scope.organizationId, permissions: own.organization });
    }
    const expected = own.workspace ?? own.organization ?? new Set<PermissionKey>();
    return fc
      .tuple(
        fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }),
        fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }),
      )
      .map(([order1, order2]) => ({ scope, expected, order1, order2 }));
  });

describe("effective permissions (property)", () => {
  it("grants exactly the target scope's binding: a binding on another workspace or organization never adds or removes a permission", () => {
    // Catches: a workspace lookup that ignores scopeId, an org fallback that
    // reads any organization binding, a union of every binding instead of
    // most-specific-wins, or a type confusion between workspace and org ids.
    fc.assert(
      fc.property(CASE, ({ scope, expected, order1 }) => {
        expect([...effectivePermissions(order1, scope)].sort()).toEqual([...expected].sort());
        for (const permission of CATALOGUE) {
          expect(resolvePermission(order1, scope, permission)).toBe(expected.has(permission));
        }
      }),
      { numRuns: 400 },
    );
  });

  it("gives the same answer whatever order the bindings were loaded in", () => {
    // The bindings query has no ORDER BY; a resolution that depends on row
    // order would grant different permissions from one request to the next.
    fc.assert(
      fc.property(CASE, ({ scope, order1, order2 }) => {
        expect([...effectivePermissions(order1, scope)].sort()).toEqual(
          [...effectivePermissions(order2, scope)].sort(),
        );
      }),
      { numRuns: 400 },
    );
  });
});
