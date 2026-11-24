// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

/*
  Stateful property of the org-scope role choke-point. The members store (the
  database boundary) is replaced by an in-memory map of user -> role key; the
  real RoleBindingService runs every command against it. After any sequence of
  assignments and removals by arbitrary actors:

  - no assignment the service ACCEPTS gives the target a permission the actor
    does not hold (no escalation), and none touches a member holding a
    permission the actor lacks;
  - the organization never loses its last Owner.

  "Holds" is read off the permission matrix while the service decides by role
  level, so the property also catches the two drifting apart.
*/

const { members } = vi.hoisted(() => ({ members: new Map<string, string>() }));

vi.mock("../organizations/members.store.js", () => ({
  withOrganizationMemberLock: async (_org: string, mutation: (tx: unknown) => Promise<unknown>) => mutation({}),
  getSystemRoleByKey: async (key: string) => ({ id: `role-${key}` }),
  getOrgScopeRoleKey: async (_org: string, userId: string) => members.get(userId) ?? null,
  countOwnerBindings: async () => [...members.values()].filter((r) => r === "owner").length,
  upsertOrganizationMemberRole: async ({ userId, roleId }: { userId: string; roleId: string }) => {
    members.set(userId, roleId.replace(/^role-/, ""));
  },
  deleteOrganizationMember: async (_org: string, userId: string) => {
    members.delete(userId);
  },
}));

import { ForbiddenException, ConflictException } from "@nestjs/common";
import { RoleBindingService } from "./role-binding.service.js";
import { SYSTEM_ROLE_KEYS, SYSTEM_ROLE_PERMISSIONS } from "./permissions.js";

const ORG = "org-1";
const USERS = ["u0", "u1", "u2", "u3", "u4"] as const;

function permissionsOf(userId: string): ReadonlySet<string> {
  const role = members.get(userId) as keyof typeof SYSTEM_ROLE_PERMISSIONS | undefined;
  return new Set(role ? SYSTEM_ROLE_PERMISSIONS[role] : []);
}

function lacking(actor: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
  return [...other].filter((p) => !actor.has(p));
}

const USER = fc.constantFrom(...USERS);
const COMMAND = fc.oneof(
  fc.record({ kind: fc.constant("assign" as const), actor: USER, target: USER, role: fc.constantFrom(...SYSTEM_ROLE_KEYS) }),
  fc.record({ kind: fc.constant("remove" as const), actor: USER, target: USER }),
);
const START = fc.tuple(...USERS.slice(1).map(() => fc.option(fc.constantFrom(...SYSTEM_ROLE_KEYS), { nil: null })));

describe("RoleBindingService (stateful property)", () => {
  it("never lets an actor grant or take away more than it holds, and never drops the last Owner", async () => {
    const service = new RoleBindingService({
      isPlatformAdmin: async () => false,
      invalidateBindingCache: () => undefined,
    } as never);

    await fc.assert(
      fc.asyncProperty(START, fc.array(COMMAND, { minLength: 1, maxLength: 25 }), async (start, commands) => {
        members.clear();
        members.set("u0", "owner");
        start.forEach((role, i) => role && members.set(USERS[i + 1]!, role));

        for (const command of commands) {
          const actorPermissions = permissionsOf(command.actor);
          const targetBefore = permissionsOf(command.target);
          const granted = command.kind === "assign" ? new Set(SYSTEM_ROLE_PERMISSIONS[command.role]) : new Set<string>();
          let accepted = true;
          try {
            if (command.kind === "assign") {
              await service.assignMemberRole({
                organizationId: ORG,
                userId: command.target,
                roleKey: command.role,
                actorId: command.actor,
              });
            } else {
              await service.removeMember({ organizationId: ORG, userId: command.target, actorId: command.actor });
            }
          } catch (error) {
            // A refusal must be one of the service's own decisions, never a crash.
            expect(error instanceof ForbiddenException || error instanceof ConflictException).toBe(true);
            accepted = false;
          }

          if (accepted) {
            expect(lacking(actorPermissions, granted), `${command.actor} granted beyond itself`).toEqual([]);
            expect(lacking(actorPermissions, targetBefore), `${command.actor} modified a stronger member`).toEqual([]);
          }
          expect([...members.values()]).toContain("owner");
        }
      }),
      { numRuns: 150 },
    );
  });
});
