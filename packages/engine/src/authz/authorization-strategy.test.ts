// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the pure most-specific-wins resolver and the OSS strategy
 * factory. These are deliberately DB-free: the resolver operates on already
 * loaded bindings, which is the unit under §4.3 of the design.
 */

import { describe, it, expect } from "vitest";
import { resolvePermission } from "./authorization-strategy.js";
import { Permission } from "./permissions.js";
import type { EffectiveBinding } from "./authz.store.js";
import type { AgentScope } from "./authz.store.js";

const scope: AgentScope = {
  agentId: "agent-1",
  workspaceId: "ws-1",
  organizationId: "org-1",
};

function orgBinding(...permissions: string[]): EffectiveBinding {
  return {
    scopeType: "organization",
    scopeId: "org-1",
    permissions: new Set(permissions as never[]),
  };
}

function wsBinding(scopeId: string, ...permissions: string[]): EffectiveBinding {
  return {
    scopeType: "workspace",
    scopeId,
    permissions: new Set(permissions as never[]),
  };
}

describe("resolvePermission (most-specific-wins)", () => {
  it("denies when the binding set is empty", () => {
    expect(resolvePermission([], scope, Permission.AGENT_READ)).toBe(false);
  });

  it("grants via an org-scoped binding (inheritance)", () => {
    const bindings = [orgBinding(Permission.AGENT_READ)];
    expect(resolvePermission(bindings, scope, Permission.AGENT_READ)).toBe(true);
  });

  it("denies an org-scoped binding that lacks the permission", () => {
    const bindings = [orgBinding(Permission.AGENT_READ)];
    expect(resolvePermission(bindings, scope, Permission.AGENT_WRITE)).toBe(false);
  });

  it("lets a workspace binding GRANT what the org binding lacks", () => {
    const bindings = [
      orgBinding(Permission.AGENT_READ),
      wsBinding("ws-1", Permission.AGENT_WRITE),
    ];
    expect(resolvePermission(bindings, scope, Permission.AGENT_WRITE)).toBe(true);
  });

  it("lets a workspace binding OVERRIDE (revoke) what the org binding grants", () => {
    // Workspace binding for ws-1 is present but does NOT include AGENT_WRITE;
    // most-specific-wins means the workspace decision (deny) beats the org grant.
    const bindings = [
      orgBinding(Permission.AGENT_READ, Permission.AGENT_WRITE),
      wsBinding("ws-1", Permission.AGENT_READ),
    ];
    expect(resolvePermission(bindings, scope, Permission.AGENT_WRITE)).toBe(false);
  });

  it("ignores a workspace binding for a DIFFERENT workspace", () => {
    const bindings = [
      orgBinding(Permission.AGENT_WRITE),
      wsBinding("ws-other", Permission.AGENT_READ),
    ];
    // The ws-other binding is irrelevant to ws-1; the org grant stands.
    expect(resolvePermission(bindings, scope, Permission.AGENT_WRITE)).toBe(true);
  });

  it("ignores an org binding for a DIFFERENT organization", () => {
    const foreign: EffectiveBinding = {
      scopeType: "organization",
      scopeId: "org-other",
      permissions: new Set([Permission.AGENT_WRITE] as never[]),
    };
    expect(resolvePermission([foreign], scope, Permission.AGENT_WRITE)).toBe(false);
  });
});
