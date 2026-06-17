// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  Permission,
  SYSTEM_ROLES,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLE_PERMISSIONS,
  type PermissionKey,
} from "./permissions.js";

/**
 * The §4.2 matrix transcribed independently of the SUT's set-union derivation,
 * so a mistake in `permissions.ts` is caught rather than mirrored. `true` = the
 * role holds the permission.
 */
const EXPECTED_MATRIX: Record<PermissionKey, Record<string, boolean>> = {
  "agent:read": { owner: true, admin: true, member: true, viewer: true },
  "agent:write": { owner: true, admin: true, member: true, viewer: false },
  "agent:delete": { owner: true, admin: true, member: false, viewer: false },
  "agent.secret:read": { owner: true, admin: true, member: false, viewer: false },
  "agent.secret:write": { owner: true, admin: true, member: false, viewer: false },
  "agent.channel:read": { owner: true, admin: true, member: true, viewer: true },
  "agent.channel:write": { owner: true, admin: true, member: true, viewer: false },
  "agent.skill:read": { owner: true, admin: true, member: true, viewer: true },
  "agent.skill:write": { owner: true, admin: true, member: true, viewer: false },
  "agent.tool:read": { owner: true, admin: true, member: true, viewer: true },
  "agent.tool:write": { owner: true, admin: true, member: true, viewer: false },
  "agent.prompt:read": { owner: true, admin: true, member: true, viewer: true },
  "agent.prompt:write": { owner: true, admin: true, member: true, viewer: false },
  "agent.room:read": { owner: true, admin: true, member: true, viewer: true },
  "agent.room:write": { owner: true, admin: true, member: true, viewer: false },
  "agent.task:read": { owner: true, admin: true, member: true, viewer: true },
  "agent.task:write": { owner: true, admin: true, member: true, viewer: false },
  "agent.knowledge:read": { owner: true, admin: true, member: true, viewer: true },
  "agent.knowledge:write": { owner: true, admin: true, member: true, viewer: false },
  "agent.governance:read": { owner: true, admin: true, member: true, viewer: true },
  "agent.governance:write": { owner: true, admin: true, member: false, viewer: false },
  "agent.export:read": { owner: true, admin: true, member: true, viewer: false },
  "conversation:read": { owner: true, admin: true, member: true, viewer: true },
  "conversation:delete": { owner: true, admin: true, member: false, viewer: false },
  "memory:read": { owner: true, admin: true, member: true, viewer: true },
  "memory:write": { owner: true, admin: true, member: true, viewer: false },
  "analytics:read": { owner: true, admin: true, member: true, viewer: true },
  "skill.catalog:read": { owner: true, admin: true, member: true, viewer: true },
  "skill.catalog:write": { owner: true, admin: true, member: false, viewer: false },
  "org:read": { owner: true, admin: true, member: true, viewer: true },
  "org:write": { owner: true, admin: false, member: false, viewer: false },
  "org.member:manage": { owner: true, admin: true, member: false, viewer: false },
  "audit_log:read": { owner: true, admin: true, member: false, viewer: false },
};

describe("RBAC permission catalog", () => {
  it("declares exactly four system roles with the design levels", () => {
    expect(SYSTEM_ROLE_KEYS).toEqual(["owner", "admin", "member", "viewer"]);
    const levels = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, r.level]));
    expect(levels).toEqual({ owner: 40, admin: 30, member: 20, viewer: 10 });
  });

  it("matches the §4.2 permission matrix exactly for every role", () => {
    for (const roleKey of SYSTEM_ROLE_KEYS) {
      const granted = new Set<string>(SYSTEM_ROLE_PERMISSIONS[roleKey]);
      for (const [permission, byRole] of Object.entries(EXPECTED_MATRIX)) {
        expect(
          granted.has(permission),
          `role ${roleKey} ${byRole[roleKey] ? "should" : "should NOT"} hold ${permission}`,
        ).toBe(byRole[roleKey]);
      }
    }
  });

  it("grants no permission outside the declared catalog", () => {
    const catalog = new Set<string>(Object.values(Permission));
    for (const roleKey of SYSTEM_ROLE_KEYS) {
      for (const permission of SYSTEM_ROLE_PERMISSIONS[roleKey]) {
        expect(catalog.has(permission), `${permission} is in the catalog`).toBe(true);
      }
    }
  });

  it("has no duplicate grants within a role", () => {
    for (const roleKey of SYSTEM_ROLE_KEYS) {
      const list = SYSTEM_ROLE_PERMISSIONS[roleKey];
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("nests roles: viewer ⊂ member ⊂ admin ⊂ owner", () => {
    const sets = Object.fromEntries(
      SYSTEM_ROLE_KEYS.map((k) => [k, new Set<string>(SYSTEM_ROLE_PERMISSIONS[k])]),
    );
    for (const p of sets.viewer) expect(sets.member.has(p)).toBe(true);
    for (const p of sets.member) expect(sets.admin.has(p)).toBe(true);
    for (const p of sets.admin) expect(sets.owner.has(p)).toBe(true);
  });
});
