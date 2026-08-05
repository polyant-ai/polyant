# PR #245 Access Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make platform-admin revocation, initial-owner bootstrap, member removal, and workspace-addressed agent reads enforce their intended server-side security boundaries.

**Architecture:** Keep the JWT as an authenticated identity, but decide platform-admin standing and active tenant membership from the database. Centralize the exceptional configured-admin bootstrap in the engine behind the existing internal-auth channel; the web login only requests that idempotent operation for the exact configured email. Treat membership/binding mutations and an addressed workspace as invariants enforced by server operations, not UI conventions.

**Tech Stack:** TypeScript, NestJS global guards/controllers, Drizzle ORM/PostgreSQL, Auth.js JWT callback, Vitest.

---

### Task 1: Revoke role-only platform access against the database

**Files:**
- Modify: `packages/engine/src/authz/permission.guard.ts`
- Modify: `packages/engine/src/authz/permission.guard.test.ts`
- Modify: `packages/engine/src/server/guard-chain.test.ts`

- [ ] **Step 1: Write the failing guard-chain test**

Add a role-only HTTP request whose JWT has `role: "platform_admin"`, while `authz.isPlatformAdmin("u1")` resolves `false`; assert `403`.

```ts
it("should_403_a_role_only_route_when_platform_admin_was_revoked_in_the_db", async () => {
  validateSessionToken.mockResolvedValue(asUser({ role: "platform_admin" }));
  authz.isPlatformAdmin.mockResolvedValue(false);
  expect((await get("/probe/role", { authorization: `Bearer ${SESSION}` })).status).toBe(403);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @polyant/engine -- src/server/guard-chain.test.ts`

Expected: the test fails with `200` because the role-only branch returns before the database check.

- [ ] **Step 3: Require a DB-backed flag for `@RequireRole(platform_admin)`**

In the existing role-only branch of `PermissionGuard`, preserve `RoleGuard` as the JWT role prefilter, then require a human principal whose `authz.isPlatformAdmin(userId)` is true when the decorated role list includes `PLATFORM_ADMIN_ROLE`. Keep non-platform legacy role lists on the existing branch.

```ts
if (requiredRoles?.includes(PLATFORM_ADMIN_ROLE)) {
  const principal = request.user as Principal;
  return isUserPrincipal(principal) && await this.authz.isPlatformAdmin(principal.userId)
    ? true
    : this.decide(false, Permission.PLATFORM_ADMIN, "revoked platform admin");
}
```

- [ ] **Step 4: Verify green**

Run: `npm run test -w @polyant/engine -- src/authz/permission.guard.test.ts src/server/guard-chain.test.ts`

Expected: all selected tests pass, including ordinary matching platform admins and the revoked-token denial.

### Task 2: Bootstrap only the configured initial owner

**Files:**
- Modify: `packages/engine/src/organizations/organizations.store.ts`
- Modify: `packages/engine/src/organizations/bootstrap.ts`
- Modify: `packages/engine/src/organizations/bootstrap.test.ts`
- Modify: `packages/engine/src/users/credentials.controller.ts`
- Modify: `packages/engine/src/users/credentials.controller.test.ts`
- Modify: `packages/web/src/lib/auth.ts`
- Modify: `packages/web/src/lib/org-provisioning.ts`
- Modify: `packages/web/src/lib/org-provisioning.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Make the engine bootstrap expect an idempotent `ensureConfiguredPlatformAdminOwner(email)` call, and make the web orchestration expect an internal bootstrap request only when the normalized sign-in email exactly equals `PLATFORM_ADMIN_EMAIL`.

```ts
await expect(resolveSignInOrgId(port, "user-1", "boss@example.test", "boss@example.test"))
  .resolves.toBe("org-default");
expect(port.ensureConfiguredPlatformAdminOwner).toHaveBeenCalledWith("boss@example.test");
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npm run test -w @polyant/engine -- src/organizations/bootstrap.test.ts src/users/credentials.controller.test.ts && npm run test -w @polyant/web -- src/lib/org-provisioning.test.ts`

Expected: the newly added expectations fail because sign-in only looks up membership and boot only promotes the role.

- [ ] **Step 3: Implement one idempotent engine operation**

In one database transaction, resolve the configured email, set both platform-admin fields, resolve default org and owner system role, upsert membership, replace the user's org-scope binding with owner, and invalidate the platform-admin/binding caches after commit. Expose it through a narrowly scoped existing-internal-secret endpoint which verifies both the secret and exact configured email. The boot path invokes the same operation; the Auth.js Node callback invokes the endpoint only for that same configured email, then stamps its returned organization id.

- [ ] **Step 4: Verify green**

Run: `npm run test -w @polyant/engine -- src/organizations/bootstrap.test.ts src/users/credentials.controller.test.ts && npm run test -w @polyant/web -- src/lib/org-provisioning.test.ts`

Expected: configured identity becomes owner at boot or first login; every other sign-in remains a read-only membership lookup.

### Task 3: Make member assignment/removal atomic and revoke tenant context

**Files:**
- Modify: `packages/engine/src/organizations/members.store.ts`
- Modify: `packages/engine/src/server/members/members.service.ts`
- Modify: `packages/engine/src/server/members/members.service.test.ts`
- Modify: `packages/engine/src/organizations/organizations.store.ts`
- Modify: `packages/engine/src/organizations/tenant.service.ts`
- Modify: `packages/engine/src/organizations/tenant.service.test.ts`

- [ ] **Step 1: Write failing service tests**

Replace expectations for separate `ensureDefaultMembership` then `assignRole` calls with one member-store mutation. Add a tenant-context test whose token org exists but whose membership lookup returns false and expects `{ organization: null, workspaces: [] }`.

```ts
await service.remove(ORG_SLUG, "u2", caller(ORG_ID));
expect(members.removeOrganizationMember).toHaveBeenCalledWith({ organizationId: ORG_ID, userId: "u2" });
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm run test -w @polyant/engine -- src/server/members/members.service.test.ts src/organizations/tenant.service.test.ts`

Expected: tests fail because removal only deletes an org binding and `TenantService` trusts the old token claim.

- [ ] **Step 3: Implement transactional member-store mutations**

Add store functions that atomically insert membership plus replace the org-scope role, and delete membership plus all bindings in the target organization. Keep owner-last and actor-hierarchy checks in `RoleBindingService` before the destructive transaction; invalidate the user's authorization cache after a successful mutation. Add `hasOrganizationMembership(organizationId, userId)` and make `TenantService` require it before exposing org/workspace topology.

- [ ] **Step 4: Verify green**

Run: `npm run test -w @polyant/engine -- src/server/members/members.service.test.ts src/organizations/tenant.service.test.ts`

Expected: no orphan membership/binding writes and a removed user’s old JWT receives no tenant context.

### Task 4: Enforce workspace address consistency for agent routes

**Files:**
- Modify: `packages/engine/src/authz/permission.guard.ts`
- Modify: `packages/engine/src/authz/permission.guard.test.ts`
- Modify: `packages/engine/src/server/guard-chain.test.ts`

- [ ] **Step 1: Write the failing mismatch test**

Extend the test request with `X-Workspace-Slug: other-workspace`; resolve the agent to a scope whose workspace id belongs to the addressed user's organization but not to that slug; assert a denial before `authz.can`.

```ts
const res = await get("/probe/agent/mine/secrets", {
  authorization: `Bearer ${SESSION}`,
  "x-workspace-slug": "other-workspace",
});
expect(res.status).toBe(403);
```

- [ ] **Step 2: Run it to verify red**

Run: `npm run test -w @polyant/engine -- src/authz/permission.guard.test.ts src/server/guard-chain.test.ts`

Expected: the request is accepted because workspace address is not part of the guard decision.

- [ ] **Step 3: Implement addressed-workspace resolution**

Add an `AuthorizationService`/store lookup that resolves `(organizationId, workspaceSlug)` to workspace id. When a route has both an agent slug and `X-Workspace-Slug`, compare that id with the resolved agent scope before granting any user or service principal; a missing or mismatching workspace denies. Preserve header-absent behaviour for existing non-web API clients.

- [ ] **Step 4: Verify green and inspect the diff**

Run: `npm run test -w @polyant/engine -- src/authz/permission.guard.test.ts src/server/guard-chain.test.ts && npm run typecheck -w @polyant/engine && npm run typecheck -w @polyant/web && git diff --check`

Expected: targeted tests and both type checks pass; `git diff --check` is silent.

## Self-review

- Spec coverage: Task 1 closes stale platform-admin authorization; Task 2 covers seed and post-first-login configured admin; Task 3 covers member removal and stale tenant context; Task 4 covers a hand-edited workspace URL at the server boundary.
- Placeholder scan: no implementation decision is deferred; each mutation names its transaction boundary and tests its externally observable behavior.
- Type consistency: `organizationId`, `userId`, `workspaceSlug`, and `AgentScope.workspaceId` are consistently named across the operations.
