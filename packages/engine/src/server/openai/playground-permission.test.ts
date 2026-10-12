// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The playground route is gated by `agent.playground:use`, decided by the real
 * PermissionGuard against the route's real decorator metadata and the real role
 * matrix. Only the binding store is stubbed.
 */

import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import { ForbiddenException } from "@nestjs/common";

vi.mock("./openai.service.js", () => ({ OpenAIService: class OpenAIService {} }));

import { InstanceChatStreamController } from "./instance-chat-stream.controller.js";
import { PermissionGuard } from "../../authz/permission.guard.js";
import { resolvePermission } from "../../authz/authorization-strategy.js";
import {
  Permission,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLE_PERMISSIONS,
  type PermissionKey,
} from "../../authz/permissions.js";
import type { AgentScope, EffectiveBinding } from "../../authz/authz.store.js";

const AGENT_IN_ORG_1: AgentScope = { agentId: "a1", workspaceId: "w1", organizationId: "org-1" };
const AGENT_IN_ORG_2: AgentScope = { agentId: "a2", workspaceId: "w2", organizationId: "org-2" };

function run(opts: { permissions: readonly PermissionKey[]; agent: AgentScope; callerOrg?: string }) {
  const bindings: EffectiveBinding[] = [
    { scopeType: "organization", scopeId: "org-1", permissions: new Set(opts.permissions) },
  ];
  const authz = {
    isPlatformAdmin: async () => false,
    resolveAgentScope: async () => opts.agent,
    resolveWorkspaceId: async () => opts.agent.workspaceId,
    can: async (_user: string, scope: AgentScope, permission: PermissionKey) =>
      resolvePermission(bindings, scope, permission),
  };
  const guard = new PermissionGuard(
    authz as never,
    { isAvailable: () => true } as never,
    new Reflector(),
  );
  const context = {
    getHandler: () => InstanceChatStreamController.prototype.playground,
    getClass: () => InstanceChatStreamController,
    switchToHttp: () => ({
      getRequest: () => ({
        user: { principalType: "user", userId: "u1", orgId: opts.callerOrg ?? "org-1" },
        params: { slug: "acme" },
        headers: {},
      }),
    }),
  } as never;
  return guard.canActivate(context);
}

describe("playground/stream authorization", () => {
  for (const role of SYSTEM_ROLE_KEYS) {
    it(`lets a ${role} use the playground, with no agent key and whatever the Web channel's state`, async () => {
      await expect(run({ permissions: SYSTEM_ROLE_PERMISSIONS[role], agent: AGENT_IN_ORG_1 })).resolves.toBe(true);
    });
  }

  it("refuses a caller who holds every permission except agent.playground:use", async () => {
    const without = Object.values(Permission).filter((p) => p !== Permission.PLAYGROUND_USE);
    await expect(run({ permissions: without, agent: AGENT_IN_ORG_1 })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses another organization's agent, even for a role that holds the permission", async () => {
    await expect(
      run({ permissions: SYSTEM_ROLE_PERMISSIONS.owner, agent: AGENT_IN_ORG_2 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a binding for another organization on this organization's agent", async () => {
    await expect(
      run({ permissions: SYSTEM_ROLE_PERMISSIONS.viewer, agent: AGENT_IN_ORG_1, callerOrg: "org-2" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
