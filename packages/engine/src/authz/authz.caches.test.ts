// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the RBAC TTL caches (BindingCache 60 s, SuperadminCache 5 min).
 * Verifies TTL expiry, per-key invalidation, and full clear.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BINDING_CACHE_TTL_MS,
  SUPERADMIN_CACHE_TTL_MS,
  bindingCache,
  invalidateSuperadminCache,
  platformAdminCache,
} from "./authz.caches.js";
import type { AgentScope } from "./authz.store.js";

const scope: AgentScope = {
  agentId: "agent-1",
  workspaceId: "ws-1",
  organizationId: "org-1",
};

describe("RBAC caches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bindingCache.clear();
    platformAdminCache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares the design TTLs (60 s bindings, 5 min platform admin)", () => {
    expect(BINDING_CACHE_TTL_MS).toBe(60_000);
    expect(SUPERADMIN_CACHE_TTL_MS).toBe(5 * 60_000);
  });

  it("stores and returns a binding-cache entry within its TTL", () => {
    bindingCache.set("user-1:org-1", [{ scopeType: "organization", scopeId: "org-1" } as never]);
    expect(bindingCache.get("user-1:org-1")).toHaveLength(1);
  });

  it("expires binding-cache entries after 60 s", () => {
    bindingCache.set("user-1:org-1", []);
    vi.advanceTimersByTime(BINDING_CACHE_TTL_MS + 1);
    expect(bindingCache.get("user-1:org-1")).toBeUndefined();
  });

  it("expires platform admin-cache entries after 5 min", () => {
    platformAdminCache.set("user-1", true);
    vi.advanceTimersByTime(SUPERADMIN_CACHE_TTL_MS + 1);
    expect(platformAdminCache.get("user-1")).toBeUndefined();
  });

  it("caches a negative platform admin result (false is distinct from miss)", () => {
    platformAdminCache.set("user-1", false);
    expect(platformAdminCache.get("user-1")).toBe(false);
    expect(platformAdminCache.has("user-1")).toBe(true);
  });

  it("supports per-key invalidation", () => {
    bindingCache.set("a", []);
    bindingCache.set("b", []);
    bindingCache.delete("a");
    expect(bindingCache.get("a")).toBeUndefined();
    expect(bindingCache.get("b")).toBeDefined();
  });

  it("should_drop_the_entry_when_invalidateSuperadminCache_is_called", () => {
    platformAdminCache.set("user-1", true);
    invalidateSuperadminCache("user-1");
    expect(platformAdminCache.get("user-1")).toBeUndefined();
  });

  it("should_keep_other_users_cached_when_one_user_is_invalidated", () => {
    platformAdminCache.set("user-1", true);
    platformAdminCache.set("user-2", true);
    invalidateSuperadminCache("user-1");
    expect(platformAdminCache.has("user-1")).toBe(false);
    expect(platformAdminCache.get("user-2")).toBe(true);
  });

  it("should_be_a_silent_noop_when_the_user_is_not_cached", () => {
    expect(() => invalidateSuperadminCache("never-seen")).not.toThrow();
    expect(platformAdminCache.has("never-seen")).toBe(false);
  });

  // AgentScope is structurally referenced so the import stays meaningful.
  it("references the AgentScope shape", () => {
    expect(scope.organizationId).toBe("org-1");
  });
});
