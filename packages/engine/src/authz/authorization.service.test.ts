// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for AuthorizationService: superadmin bypass + cache, can() with
 * cached bindings, scope resolution, and binding-cache invalidation.
 */

const { mockReadPlatformAdminFlag, mockReadAgentScope, mockReadUserBindings } =
  vi.hoisted(() => ({
    mockReadPlatformAdminFlag: vi.fn(),
    mockReadAgentScope: vi.fn(),
    mockReadUserBindings: vi.fn(),
  }));

vi.mock("./authz.store.js", () => ({
  readPlatformAdminFlag: mockReadPlatformAdminFlag,
  readAgentScope: mockReadAgentScope,
  readUserBindings: mockReadUserBindings,
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AuthorizationService } from "./authorization.service.js";
import { OssStrategy } from "./authorization-strategy.js";
import { bindingCache, superadminCache, bindingCacheKey } from "./authz.caches.js";
import { Permission } from "./permissions.js";
import type { AgentScope } from "./authz.store.js";

const scope: AgentScope = {
  agentId: "agent-1",
  workspaceId: "ws-1",
  organizationId: "org-1",
};

function makeService(): AuthorizationService {
  return new AuthorizationService(new OssStrategy());
}

describe("AuthorizationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindingCache.clear();
    superadminCache.clear();
  });

  describe("isPlatformAdmin", () => {
    it("reads the DB flag on a cache miss and caches the result", async () => {
      mockReadPlatformAdminFlag.mockResolvedValue(true);
      const svc = makeService();
      expect(await svc.isPlatformAdmin("user-1")).toBe(true);
      expect(await svc.isPlatformAdmin("user-1")).toBe(true);
      expect(mockReadPlatformAdminFlag).toHaveBeenCalledTimes(1);
    });

    it("caches a negative result too", async () => {
      mockReadPlatformAdminFlag.mockResolvedValue(false);
      const svc = makeService();
      expect(await svc.isPlatformAdmin("user-2")).toBe(false);
      expect(await svc.isPlatformAdmin("user-2")).toBe(false);
      expect(mockReadPlatformAdminFlag).toHaveBeenCalledTimes(1);
    });
  });

  describe("can", () => {
    it("grants when an org binding carries the permission", async () => {
      mockReadUserBindings.mockResolvedValue([
        { scopeType: "organization", scopeId: "org-1", permissions: new Set([Permission.AGENT_READ]) },
      ]);
      const svc = makeService();
      expect(await svc.can("user-1", scope, Permission.AGENT_READ)).toBe(true);
    });

    it("denies on an empty binding set", async () => {
      mockReadUserBindings.mockResolvedValue([]);
      const svc = makeService();
      expect(await svc.can("user-1", scope, Permission.AGENT_READ)).toBe(false);
    });

    it("caches bindings per user+org (single DB read across calls)", async () => {
      mockReadUserBindings.mockResolvedValue([
        { scopeType: "organization", scopeId: "org-1", permissions: new Set([Permission.AGENT_READ]) },
      ]);
      const svc = makeService();
      await svc.can("user-1", scope, Permission.AGENT_READ);
      await svc.can("user-1", scope, Permission.AGENT_WRITE);
      expect(mockReadUserBindings).toHaveBeenCalledTimes(1);
    });
  });

  describe("resolveAgentScope", () => {
    it("delegates to the store", async () => {
      mockReadAgentScope.mockResolvedValue(scope);
      const svc = makeService();
      expect(await svc.resolveAgentScope("agent-1")).toEqual(scope);
      expect(mockReadAgentScope).toHaveBeenCalledWith("agent-1");
    });

    it("returns null for an unknown agent", async () => {
      mockReadAgentScope.mockResolvedValue(null);
      const svc = makeService();
      expect(await svc.resolveAgentScope("nope")).toBeNull();
    });
  });

  describe("invalidateBindingCache", () => {
    it("clears the cached bindings for the user+org", async () => {
      mockReadUserBindings.mockResolvedValue([]);
      const svc = makeService();
      await svc.can("user-1", scope, Permission.AGENT_READ);
      expect(bindingCache.has(bindingCacheKey("user-1", "org-1"))).toBe(true);
      svc.invalidateBindingCache("user-1", "org-1");
      expect(bindingCache.has(bindingCacheKey("user-1", "org-1"))).toBe(false);
    });
  });
});
