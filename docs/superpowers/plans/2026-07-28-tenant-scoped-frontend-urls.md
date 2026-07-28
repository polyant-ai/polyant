# Tenant-scoped Frontend URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every agent-related admin route under `/organizations/{orgSlug}/workspaces/{workspaceSlug}/…`, with the slugs validated against a new `GET /api/me`.

**Architecture:** Real Next.js dynamic segments (directories move with `git mv`), a `TenantProvider` mounted in the admin layout so the sidebar can build hrefs everywhere, and a `TenantScopeGuard` in the nested layouts that 404s a URL whose segments do not match the caller's tenancy. Three tiers: workspace-level (agents and their data), org-level (dashboard, members, audit logs), deployment-level (settings, skills — unchanged, flat).

**Tech Stack:** Next.js 16 (App Router, React 19), NestJS 11 + Drizzle (engine), Vitest + Testing Library (unit/component), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-28-tenant-scoped-frontend-urls-design.md`

## Global Constraints

- Every new file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Filenames in kebab-case. `{entity}.{type}.ts` in the engine.
- **Engine** relative imports MUST end in `.js`. **Web unit/component tests** use relative imports with NO extension. **Playwright e2e** imports DO carry `.js`.
- Named exports only — the sole exception is Next.js `page.tsx` / `layout.tsx`, which require a default export.
- **Engine tests** explicitly import `{ describe, it, expect, beforeEach, vi }` from `"vitest"`, with `vi.hoisted` + `vi.mock` blocks placed ABOVE the import block. **Web tests** import nothing (`globals: true`) and mock inline.
- Web tests mock `@/lib/i18n/context` so `t` returns the key; assertions match raw key strings.
- i18n keys are FLAT dotted strings and MUST be added to BOTH `packages/web/src/lib/i18n/locales/en.json` and `it.json`, appended at the end of the file. `en.json` is the source of the `TranslationKey` union.
- NestJS constructor injection MUST use explicit `@Inject(ClassName)` (tsx has no `emitDecoratorMetadata`).
- Never read `process.env` outside `packages/engine/src/config.ts`.
- Files ≤400 lines, functions ≤30 lines.
- Every commit message ends with `Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>` (DCO).
- **Commit messages: heredocs do not survive this environment's shell** — `cat > file <<'EOF'` arrives with literalised `\n` and fails to parse, and multi-line `git commit -m` corrupts newlines the same way. Write the message to a file with your file-writing tool, then `git commit -F <file>`. The `<<'EOF'` blocks in each task's commit step are the message **content** to write, not a command to paste.
- Commands run from the monorepo root. Web unit tests: `npm test -w @polyant/web`. Engine unit tests: `npm run test:unit -w @polyant/engine`.

---

### Task 1: Engine — `GET /api/me` returns the caller's tenancy

**Files:**
- Modify: `packages/engine/src/organizations/organizations.store.ts` (append two queries)
- Create: `packages/engine/src/organizations/tenant.service.ts`
- Create: `packages/engine/src/organizations/tenant.service.test.ts`
- Modify: `packages/engine/src/organizations/organizations.module.ts`
- Modify: `packages/engine/src/users/me.controller.ts`
- Modify: `packages/engine/src/users/users.module.ts`
- Modify: `packages/web/next.config.ts:38`

**Interfaces:**
- Produces: `TenantContext` (`{ user: { id, email, name: string | null }, organization: { slug, name } | null, workspaces: WorkspaceIdentity[] }`); `TenantService.getContextFor(user: AuthenticatedUser): Promise<TenantContext>`; store functions `findOrganizationById(organizationId: string): Promise<OrganizationIdentity | null>` and `listWorkspacesByOrganization(organizationId: string): Promise<WorkspaceIdentity[]>`.
- Consumes: nothing (first task).

`organization: null` is a valid answer — a JWT minted before RBAC carries no `orgId`. Do NOT throw for it.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/organizations/tenant.service.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for TenantService — the /api/me tenancy resolver. Covers the
 * legacy-token path (no orgId → organization: null, never a throw), a resolved
 * organization with its workspaces, and an orgId that no longer exists.
 */

const { mockFindOrganizationById, mockListWorkspacesByOrganization } = vi.hoisted(() => ({
  mockFindOrganizationById: vi.fn(),
  mockListWorkspacesByOrganization: vi.fn(),
}));

vi.mock("./organizations.store.js", () => ({
  findOrganizationById: mockFindOrganizationById,
  listWorkspacesByOrganization: mockListWorkspacesByOrganization,
}));

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TenantService } from "./tenant.service.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: "user-1",
    email: "owner@example.test",
    principalType: "user",
    orgId: ORG_ID,
    ...overrides,
  };
}

describe("TenantService.getContextFor", () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TenantService();
  });

  it("resolves the organization and its workspaces", async () => {
    mockFindOrganizationById.mockResolvedValue({ id: ORG_ID, slug: "default", name: "Default" });
    mockListWorkspacesByOrganization.mockResolvedValue([
      { slug: "default", name: "Default", isDefault: true },
    ]);

    const context = await service.getContextFor(makeUser({ name: "Owner" }));

    expect(context.organization).toEqual({ slug: "default", name: "Default" });
    expect(context.workspaces).toEqual([{ slug: "default", name: "Default", isDefault: true }]);
    expect(context.user).toEqual({ id: "user-1", email: "owner@example.test", name: "Owner" });
    expect(mockFindOrganizationById).toHaveBeenCalledWith(ORG_ID);
  });

  it("returns organization: null for a legacy token carrying no orgId", async () => {
    const context = await service.getContextFor(makeUser({ orgId: undefined }));

    expect(context.organization).toBeNull();
    expect(context.workspaces).toEqual([]);
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
  });

  it("returns organization: null when the orgId no longer resolves", async () => {
    mockFindOrganizationById.mockResolvedValue(null);

    const context = await service.getContextFor(makeUser());

    expect(context.organization).toBeNull();
    expect(context.workspaces).toEqual([]);
    expect(mockListWorkspacesByOrganization).not.toHaveBeenCalled();
  });

  it("normalises a missing name to null", async () => {
    mockFindOrganizationById.mockResolvedValue({ id: ORG_ID, slug: "default", name: "Default" });
    mockListWorkspacesByOrganization.mockResolvedValue([]);

    const context = await service.getContextFor(makeUser({ name: undefined }));

    expect(context.user.name).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- tenant.service`
Expected: FAIL — `Failed to resolve import "./tenant.service.js"`.

- [ ] **Step 3: Append the two store queries**

Append to `packages/engine/src/organizations/organizations.store.ts` (the file already imports `eq` from `drizzle-orm`, `db`, and `organizations` + `workspaces` from `./organization.schema.js` — no new imports needed):

```ts
/** An organization as the management plane and the frontend URLs address it. */
export interface OrganizationIdentity {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/** A workspace as the frontend addresses it in a tenant-scoped URL. */
export interface WorkspaceIdentity {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** Resolve an organization by UUID — the `orgId` the JWT carries. */
export async function findOrganizationById(
  organizationId: string,
): Promise<OrganizationIdentity | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}

/** Every workspace in an organization, slug-ordered so the list is stable. */
export async function listWorkspacesByOrganization(
  organizationId: string,
): Promise<WorkspaceIdentity[]> {
  return db
    .select({
      slug: workspaces.slug,
      name: workspaces.name,
      isDefault: workspaces.isDefault,
    })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId))
    .orderBy(workspaces.slug);
}
```

- [ ] **Step 4: Create the service**

Create `packages/engine/src/organizations/tenant.service.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import {
  findOrganizationById,
  listWorkspacesByOrganization,
  type WorkspaceIdentity,
} from "./organizations.store.js";

/**
 * What the admin panel needs to render tenant-scoped URLs: who the caller is,
 * which organization they act within, and which workspaces that organization
 * holds.
 *
 * `isPlatformAdmin` is deliberately absent — platform-admin status is resolved
 * from the DB on each privileged check so it stays revocable (see
 * `AuthenticatedUser`), and no consumer needs it here yet.
 */
export interface TenantContext {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string | null;
  };
  readonly organization: { readonly slug: string; readonly name: string } | null;
  readonly workspaces: readonly WorkspaceIdentity[];
}

@Injectable()
export class TenantService {
  /**
   * Resolve the caller's own tenancy. `organization: null` is a VALID answer,
   * not an error: a JWT minted before RBAC carries no `orgId`, and the frontend
   * turns that into a "sign in again" prompt. Never throw for it.
   */
  async getContextFor(user: AuthenticatedUser): Promise<TenantContext> {
    const identity = {
      id: user.userId,
      email: user.email,
      name: user.name ?? null,
    };

    if (!user.orgId) {
      return { user: identity, organization: null, workspaces: [] };
    }

    const organization = await findOrganizationById(user.orgId);
    if (!organization) {
      return { user: identity, organization: null, workspaces: [] };
    }

    const workspaces = await listWorkspacesByOrganization(organization.id);
    return {
      user: identity,
      organization: { slug: organization.slug, name: organization.name },
      workspaces,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- tenant.service`
Expected: PASS — 4 tests.

- [ ] **Step 6: Provide the service and expose the route**

Replace `packages/engine/src/organizations/organizations.module.ts` with (keep the existing `bootstrapOrganizations` import and `onModuleInit` body exactly as they are — only the decorator and class body gain the provider):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module, type OnModuleInit } from "@nestjs/common";
import { bootstrapOrganizations } from "./bootstrap.js";
import { TenantService } from "./tenant.service.js";

@Module({
  providers: [TenantService],
  exports: [TenantService],
})
export class OrganizationsModule implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    try {
      await bootstrapOrganizations();
    } catch (err) {
      // Never block boot — mirror the existing superadmin seed behaviour.
      console.error("[organizations] Bootstrap failed:", err);
    }
  }
}
```

In `packages/engine/src/users/users.module.ts`, add the import so `MeController` can inject `TenantService`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { UsersService } from "./users.service.js";
import { UsersController } from "./users.controller.js";
import { MeController } from "./me.controller.js";
import { CredentialsController } from "./credentials.controller.js";
import { OrganizationsModule } from "../organizations/organizations.module.js";

@Module({
  imports: [OrganizationsModule],
  controllers: [UsersController, MeController, CredentialsController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

Replace `packages/engine/src/users/me.controller.ts` with:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { UsersService } from "./users.service.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { TenantService } from "../organizations/tenant.service.js";
import { Permission, RequirePermission } from "../authz/index.js";

@Controller("api/me")
export class MeController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TenantService) private readonly tenant: TenantService,
  ) {}

  /**
   * The caller's own tenancy, used by the admin panel to build and validate
   * tenant-scoped URLs.
   *
   * `@RequirePermission` is REQUIRED, not optional: PermissionGuard denies any
   * route that declares no permission once `AUTHZ_ENFORCE=true`. ORG_READ is
   * held by every system role, Viewer included. A legacy token carrying no
   * `orgId` yields no scope to authorize against, so in enforce mode it gets a
   * 403 — the frontend treats that exactly like `organization: null`, since the
   * remedy (sign in again) is the same.
   */
  @RequirePermission(Permission.ORG_READ)
  @Get()
  async context(@CurrentUser() actor: AuthenticatedUser) {
    return this.tenant.getContextFor(actor);
  }

  @Post("password")
  async changePassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    await this.users.changeOwnPassword(actor, body);
    return { ok: true };
  }
}
```

In `packages/web/next.config.ts`, add the bare-path rewrite immediately after line 38 (`/api/me/:path*` does not match the collection path itself):

```ts
      { source: "/api/me", destination: `${ENGINE_URL}/api/me` },
```

- [ ] **Step 7: Verify the whole engine still typechecks and tests green**

Run: `npm run typecheck -w @polyant/engine && npm run test:unit -w @polyant/engine`
Expected: typecheck clean; full unit suite PASS.

- [ ] **Step 8: Commit**

```bash
cat > /tmp/t1.txt <<'EOF'
feat(engine): expose the caller's tenancy via GET /api/me

The admin panel needs the organization and workspace slugs to build and
validate tenant-scoped URLs, and no endpoint exposed them. Adds a @Get() to
the existing MeController backed by a new TenantService.

organization: null is a valid response, not an error: a JWT minted before
RBAC carries no orgId. ORG_READ is declared explicitly because PermissionGuard
denies undeclared routes once AUTHZ_ENFORCE=true.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/engine/src/organizations packages/engine/src/users packages/web/next.config.ts
git commit -F /tmp/t1.txt
```

---

### Task 2: Web — the tenant path builders

**Files:**
- Create: `packages/web/src/lib/tenant/paths.ts`
- Create: `packages/web/src/lib/tenant/paths.test.ts`

**Interfaces:**
- Produces: `orgPath(orgSlug: string, sub?: string): string`, `workspacePath(orgSlug: string, workspaceSlug: string, sub?: string): string`, `PLATFORM_PREFIX: string`. Every later task builds URLs through these — no task writes the URL shape inline.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/tenant/paths.test.ts` (no imports of `describe`/`it`/`expect` — `globals: true`; relative import without extension):

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { orgPath, workspacePath, PLATFORM_PREFIX } from "./paths";

describe("orgPath", () => {
  it("builds the organization root", () => {
    expect(orgPath("acme")).toBe("/organizations/acme");
  });

  it("appends a sub-path", () => {
    expect(orgPath("acme", "/members")).toBe("/organizations/acme/members");
  });

  it("tolerates a sub-path without a leading slash", () => {
    expect(orgPath("acme", "members")).toBe("/organizations/acme/members");
  });

  it("treats a bare slash as no sub-path", () => {
    expect(orgPath("acme", "/")).toBe("/organizations/acme");
  });

  it("encodes the slug", () => {
    expect(orgPath("a b")).toBe("/organizations/a%20b");
  });
});

describe("workspacePath", () => {
  it("builds the workspace root", () => {
    expect(workspacePath("acme", "core")).toBe("/organizations/acme/workspaces/core");
  });

  it("appends a sub-path", () => {
    expect(workspacePath("acme", "core", "/instances")).toBe(
      "/organizations/acme/workspaces/core/instances",
    );
  });

  it("preserves a query string in the sub-path", () => {
    expect(workspacePath("acme", "core", "/conversations?id=42")).toBe(
      "/organizations/acme/workspaces/core/conversations?id=42",
    );
  });

  it("encodes both slugs", () => {
    expect(workspacePath("a b", "c d")).toBe("/organizations/a%20b/workspaces/c%20d");
  });
});

describe("PLATFORM_PREFIX", () => {
  it("is reserved outside the tenant tree", () => {
    expect(PLATFORM_PREFIX).toBe("/platform");
    expect(PLATFORM_PREFIX.startsWith("/organizations")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @polyant/web -- paths`
Expected: FAIL — cannot resolve `./paths`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/tenant/paths.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single place the tenant URL shape is written down:
 *
 *   /organizations/{orgSlug}/workspaces/{workspaceSlug}{sub}
 *
 * Pure functions — no React, no hooks — so components, redirects and tests all
 * share one definition. Only the slugs are encoded; `sub` is passed through so
 * callers can append an already-encoded path plus a query string.
 */

/** Reserved for the future platform management console (deployment scope). */
export const PLATFORM_PREFIX = "/platform";

function joinSub(base: string, sub?: string): string {
  if (!sub || sub === "/") return base;
  return sub.startsWith("/") ? `${base}${sub}` : `${base}/${sub}`;
}

/** Organization-scoped path: `/organizations/{orgSlug}{sub}`. */
export function orgPath(orgSlug: string, sub?: string): string {
  return joinSub(`/organizations/${encodeURIComponent(orgSlug)}`, sub);
}

/** Workspace-scoped path: `/organizations/{org}/workspaces/{ws}{sub}`. */
export function workspacePath(
  orgSlug: string,
  workspaceSlug: string,
  sub?: string,
): string {
  const base = `${orgPath(orgSlug)}/workspaces/${encodeURIComponent(workspaceSlug)}`;
  return joinSub(base, sub);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @polyant/web -- paths`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/t2.txt <<'EOF'
feat(web): add tenant path builders

One place defines the tenant URL shape, so no component writes
/organizations/... inline. Pure functions, no React, so redirects and tests
share the same definition.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/web/src/lib/tenant
git commit -F /tmp/t2.txt
```

---

### Task 3: Web — API client `me.get()` and the param validator

**Files:**
- Modify: `packages/web/src/lib/api-types.ts` (append two interfaces)
- Modify: `packages/web/src/lib/api.ts` (import the type; add `me.get`)
- Create: `packages/web/src/lib/tenant/validate.ts`
- Create: `packages/web/src/lib/tenant/validate.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 (independent).
- Produces: `TenantWorkspace` (`{ slug: string; name: string; isDefault: boolean }`); `TenantContextPayload` (`{ user: { id: string; email: string; name: string | null }; organization: { slug: string; name: string } | null; workspaces: TenantWorkspace[] }`); `api.me.get(): Promise<TenantContextPayload>`; `TenantScope = Pick<TenantContextPayload, "organization" | "workspaces">`; `validateTenantParams(scope: TenantScope, orgSlug: string, workspaceSlug?: string): boolean`. The validator takes the NARROW `TenantScope`, not the whole payload, so the guard can pass what it holds without fabricating `user` fields.

`DEFAULT_ORG_SLUG` is NOT removed here — the members page cannot read a route param until Task 6 moves it. Removing it now would break the build.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/tenant/validate.test.ts`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { validateTenantParams } from "./validate";
import type { TenantContextPayload } from "@/lib/api-types";

function makePayload(overrides: Partial<TenantContextPayload> = {}): TenantContextPayload {
  return {
    user: { id: "user-1", email: "owner@example.test", name: "Owner" },
    organization: { slug: "default", name: "Default" },
    workspaces: [
      { slug: "default", name: "Default", isDefault: true },
      { slug: "research", name: "Research", isDefault: false },
    ],
    ...overrides,
  };
}

describe("validateTenantParams", () => {
  it("accepts the caller's own organization", () => {
    expect(validateTenantParams(makePayload(), "default")).toBe(true);
  });

  it("rejects another organization's slug", () => {
    expect(validateTenantParams(makePayload(), "acme")).toBe(false);
  });

  it("accepts any workspace belonging to the organization", () => {
    expect(validateTenantParams(makePayload(), "default", "research")).toBe(true);
  });

  it("rejects a workspace that does not belong to the organization", () => {
    expect(validateTenantParams(makePayload(), "default", "ghost")).toBe(false);
  });

  it("rejects everything when the caller has no organization", () => {
    const payload = makePayload({ organization: null, workspaces: [] });
    expect(validateTenantParams(payload, "default")).toBe(false);
  });

  it("ignores the workspace when none is addressed", () => {
    const payload = makePayload({ workspaces: [] });
    expect(validateTenantParams(payload, "default")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @polyant/web -- validate`
Expected: FAIL — cannot resolve `./validate`, and `TenantContextPayload` is not exported.

- [ ] **Step 3: Append the payload types**

Append to `packages/web/src/lib/api-types.ts`:

```ts
// ── Tenancy (GET /api/me) ───────────────────────────────────────────

/** A workspace as the frontend addresses it in a tenant-scoped URL. */
export interface TenantWorkspace {
  slug: string;
  name: string;
  isDefault: boolean;
}

/**
 * The caller's own tenancy. `organization: null` is a valid response — a JWT
 * minted before RBAC carries no orgId — and means "sign in again", not "error".
 */
export interface TenantContextPayload {
  user: { id: string; email: string; name: string | null };
  organization: { slug: string; name: string } | null;
  workspaces: TenantWorkspace[];
}
```

- [ ] **Step 4: Add the API method**

In `packages/web/src/lib/api.ts`, add `TenantContextPayload` to the existing type import block from `"./api-types"` (the block ending at line 119, after `OrganizationMember`), then add `get` as the FIRST entry of the existing `me` object (currently at line 203):

```ts
  me: {
    get: () => request<TenantContextPayload>("/api/me"),
    changePassword: (data: { currentPassword?: string; newPassword: string }) =>
      request<{ ok: boolean }>("/api/me/password", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },
```

- [ ] **Step 5: Write the validator**

Create `packages/web/src/lib/tenant/validate.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TenantContextPayload } from "@/lib/api-types";

/** Just the tenancy fields — the guard holds these without the `user` block. */
export type TenantScope = Pick<TenantContextPayload, "organization" | "workspaces">;

/**
 * True when a URL's tenant segments address the caller's actual tenancy.
 *
 * A mismatch means a hand-edited or stale URL, and the caller renders a 404
 * rather than wrapping the caller's own data in another tenant's chrome. A
 * caller with no organization can address nothing.
 */
export function validateTenantParams(
  scope: TenantScope,
  orgSlug: string,
  workspaceSlug?: string,
): boolean {
  if (!scope.organization) return false;
  if (scope.organization.slug !== orgSlug) return false;
  if (workspaceSlug === undefined) return true;
  return scope.workspaces.some((workspace) => workspace.slug === workspaceSlug);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w @polyant/web -- validate`
Expected: PASS — 6 tests.

- [ ] **Step 7: Verify the web package still typechecks**

Run: `npm run typecheck -w @polyant/web`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
cat > /tmp/t3.txt <<'EOF'
feat(web): add api.me.get() and the tenant param validator

The payload types and the pure slug-comparison used by the route guard.
DEFAULT_ORG_SLUG stays for now: the members page cannot read a route param
until it moves under [orgSlug].

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/web/src/lib
git commit -F /tmp/t3.txt
```

---

### Task 4: Web — `TenantProvider`, the fallback UI, and mounting both

**Files:**
- Create: `packages/web/src/lib/tenant/tenant-context.tsx`
- Create: `packages/web/src/lib/tenant/tenant-context.test.tsx`
- Create: `packages/web/src/components/layout/tenant-unavailable.tsx`
- Modify: `packages/web/src/lib/i18n/locales/en.json` (append 6 keys before the closing brace)
- Modify: `packages/web/src/lib/i18n/locales/it.json` (append the same 6 keys)
- Modify: `packages/web/src/app/(admin)/layout.tsx`

**Interfaces:**
- Consumes: `api.me.get()` and `TenantContextPayload` (Task 3).
- Produces: `TenantProvider`, `useTenant(): TenantContextValue`, `resetTenantCache(): void`, and the exported types `TenantState` / `TenantContextValue`. `TenantContextValue = TenantState & { retry: () => void }`, so consumers narrow on `tenant.status` directly (`"loading" | "ready" | "no-organization" | "error"`) and read `tenant.organization` / `tenant.workspaces` only in the `"ready"` branch. Also produces `<TenantUnavailable />`.

The provider mounts in the ADMIN layout, above the dynamic segments, because the sidebar needs tenant data even on `/settings` where no tenant params exist. It must NOT block the shell: `/settings` and `/skills` need no tenant data and must keep working when `/api/me` fails.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/tenant/tenant-context.test.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TenantProvider, useTenant, resetTenantCache } from "./tenant-context";

const { mockMeGet } = vi.hoisted(() => ({ mockMeGet: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: { me: { get: (...args: unknown[]) => mockMeGet(...args) } },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

function Probe() {
  const tenant = useTenant();
  return (
    <div>
      <span data-testid="status">{tenant.status}</span>
      {tenant.status === "ready" && <span data-testid="org">{tenant.organization.slug}</span>}
      <button onClick={tenant.retry}>retry</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <TenantProvider>
      <Probe />
    </TenantProvider>,
  );
}

const PAYLOAD = {
  user: { id: "user-1", email: "owner@example.test", name: "Owner" },
  organization: { slug: "default", name: "Default" },
  workspaces: [{ slug: "default", name: "Default", isDefault: true }],
};

describe("TenantProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTenantCache();
  });

  it("starts in loading and resolves to ready", async () => {
    mockMeGet.mockResolvedValue(PAYLOAD);

    renderProbe();
    expect(screen.getByTestId("status")).toHaveTextContent("loading");

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("org")).toHaveTextContent("default");
  });

  it("maps a null organization to no-organization", async () => {
    mockMeGet.mockResolvedValue({ ...PAYLOAD, organization: null, workspaces: [] });

    renderProbe();

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("no-organization"),
    );
  });

  it("maps a 403 to no-organization — same legacy token, same remedy", async () => {
    const { ApiError } = await import("@/lib/api");
    mockMeGet.mockRejectedValue(new ApiError(403, "Missing permission: org:read"));

    renderProbe();

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("no-organization"),
    );
  });

  it("maps any other failure to error", async () => {
    mockMeGet.mockRejectedValue(new Error("network down"));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
  });

  it("does not cache a rejection — retry refetches and can succeed", async () => {
    mockMeGet.mockRejectedValueOnce(new Error("network down"));
    mockMeGet.mockResolvedValueOnce(PAYLOAD);

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));

    await userEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(mockMeGet).toHaveBeenCalledTimes(2);
  });

  it("fetches once for two providers sharing the module cache", async () => {
    mockMeGet.mockResolvedValue(PAYLOAD);

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    renderProbe();
    await waitFor(() => expect(screen.getAllByTestId("status")).toHaveLength(2));

    expect(mockMeGet).toHaveBeenCalledTimes(1);
  });

  it("throws when useTenant is used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow(/useTenant must be used within TenantProvider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @polyant/web -- tenant-context`
Expected: FAIL — cannot resolve `./tenant-context`.

- [ ] **Step 3: Write the provider**

Create `packages/web/src/lib/tenant/tenant-context.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { TenantContextPayload, TenantWorkspace } from "@/lib/api-types";

/**
 * `no-organization` is the legacy-token state: the JWT predates RBAC and
 * carries no orgId. It arrives either as `organization: null` (shadow mode) or
 * as a 403 (enforce mode — no scope to authorize against). Both have the same
 * remedy, so they are one state.
 */
export type TenantState =
  | { status: "loading" }
  | {
      status: "ready";
      organization: { slug: string; name: string };
      workspaces: TenantWorkspace[];
    }
  | { status: "no-organization" }
  | { status: "error" };

export type TenantContextValue = TenantState & { retry: () => void };

const TenantContext = createContext<TenantContextValue | null>(null);

/**
 * Module-level cache so nested navigation does not refetch. A rejected promise
 * is deliberately NOT cached — otherwise retry would replay the same failure
 * forever.
 */
let inflight: Promise<TenantContextPayload> | null = null;

function fetchTenant(): Promise<TenantContextPayload> {
  inflight ??= api.me.get().catch((err: unknown) => {
    inflight = null;
    throw err;
  });
  return inflight;
}

/** Test seam: drop the module cache between tests. */
export function resetTenantCache(): void {
  inflight = null;
}

function toState(payload: TenantContextPayload): TenantState {
  if (!payload.organization) return { status: "no-organization" };
  return {
    status: "ready",
    organization: payload.organization,
    workspaces: payload.workspaces,
  };
}

function toErrorState(err: unknown): TenantState {
  const isLegacyToken = err instanceof ApiError && err.status === 403;
  return { status: isLegacyToken ? "no-organization" : "error" };
}

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TenantState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetchTenant().then(
      (payload) => setState(toState(payload)),
      (err: unknown) => setState(toErrorState(err)),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const retry = useCallback(() => {
    resetTenantCache();
    load();
  }, [load]);

  return (
    <TenantContext.Provider value={{ ...state, retry }}>{children}</TenantContext.Provider>
  );
}

export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error("useTenant must be used within TenantProvider");
  return ctx;
}

/** The workspace a tenant-scoped link should default to when none is addressed. */
export function defaultWorkspaceSlug(tenant: TenantContextValue): string | null {
  if (tenant.status !== "ready") return null;
  const preferred = tenant.workspaces.find((workspace) => workspace.isDefault);
  return (preferred ?? tenant.workspaces[0])?.slug ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @polyant/web -- tenant-context`
Expected: PASS — 7 tests.

- [ ] **Step 5: Add the i18n keys**

Append before the closing `}` of `packages/web/src/lib/i18n/locales/en.json` (add a comma to the previously-last entry):

```json
  "tenant.noOrganization.title": "Your session predates organizations",
  "tenant.noOrganization.description": "Sign in again to attach your session to an organization. Nothing is lost — this only refreshes your session.",
  "tenant.noOrganization.action": "Sign in again",
  "tenant.error.title": "Could not load your organization",
  "tenant.error.description": "The server did not answer. Check your connection and try again.",
  "tenant.error.retry": "Try again"
```

And the same keys in `packages/web/src/lib/i18n/locales/it.json`:

```json
  "tenant.noOrganization.title": "La tua sessione precede le organizzazioni",
  "tenant.noOrganization.description": "Esegui di nuovo l'accesso per collegare la sessione a un'organizzazione. Non perdi nulla: viene solo rinnovata la sessione.",
  "tenant.noOrganization.action": "Accedi di nuovo",
  "tenant.error.title": "Impossibile caricare la tua organizzazione",
  "tenant.error.description": "Il server non ha risposto. Controlla la connessione e riprova.",
  "tenant.error.retry": "Riprova"
```

- [ ] **Step 6: Write the fallback UI**

Create `packages/web/src/components/layout/tenant-unavailable.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";
import { useTenant } from "@/lib/tenant/tenant-context";

/**
 * Rendered instead of tenant-scoped children when the tenancy cannot be
 * established. Two causes, two remedies: a legacy token needs a fresh sign-in,
 * anything else is retryable.
 */
export function TenantUnavailable() {
  const { t } = useI18n();
  const tenant = useTenant();
  const isLegacyToken = tenant.status === "no-organization";

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h2 className="text-lg font-semibold">
        {t(isLegacyToken ? "tenant.noOrganization.title" : "tenant.error.title")}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {t(isLegacyToken ? "tenant.noOrganization.description" : "tenant.error.description")}
      </p>
      {isLegacyToken ? (
        <Button className="mt-6" onClick={() => signOut({ callbackUrl: "/login" })}>
          {t("tenant.noOrganization.action")}
        </Button>
      ) : (
        <Button className="mt-6" onClick={tenant.retry}>
          {t("tenant.error.retry")}
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Mount the provider in the admin layout**

In `packages/web/src/app/(admin)/layout.tsx`, add the import and wrap the shell. The provider goes OUTSIDE `SidebarProvider` so `AppSidebar` can call `useTenant()`:

```tsx
import { TenantProvider } from "@/lib/tenant/tenant-context";
```

and change the returned JSX to:

```tsx
  return (
    <TenantProvider>
      <ActivityStreamProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <AppSidebar user={user} />
          <SidebarInset>
            <Header />
            <div className="flex-1 p-6">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </ActivityStreamProvider>
    </TenantProvider>
  );
```

- [ ] **Step 8: Verify typecheck and the full web suite**

Run: `npm run typecheck -w @polyant/web && npm test -w @polyant/web`
Expected: typecheck clean; suite PASS (no existing test renders `AppSidebar` outside the provider yet — Task 7 adds the sidebar's dependency on it).

- [ ] **Step 9: Commit**

```bash
cat > /tmp/t4.txt <<'EOF'
feat(web): add TenantProvider and the tenant-unavailable fallback

Mounted in the admin layout rather than the nested tenant layout: the sidebar
lives above the dynamic segments and needs tenant data even on /settings,
where no tenant params exist.

A 403 and organization: null collapse into one no-organization state — both
mean a JWT minted before RBAC, and both are fixed by signing in again. A
rejected fetch is never cached, so retry can actually succeed.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/web/src/lib packages/web/src/components/layout/tenant-unavailable.tsx "packages/web/src/app/(admin)/layout.tsx"
git commit -F /tmp/t4.txt
```

---

### Task 5: Web — `TenantScopeGuard`

**Files:**
- Create: `packages/web/src/components/layout/tenant-scope-guard.tsx`
- Create: `packages/web/src/components/layout/tenant-scope-guard.test.tsx`

**Interfaces:**
- Consumes: `useTenant` (Task 4), `validateTenantParams` (Task 3), `TenantUnavailable` (Task 4).
- Produces: `<TenantScopeGuard orgSlug={string} workspaceSlug={string | undefined}>{children}</TenantScopeGuard>`. Task 6's nested layouts are its only callers: they are server components that `await params` and pass the slugs down as plain strings.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/layout/tenant-scope-guard.test.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { TenantScopeGuard } from "./tenant-scope-guard";
import type { TenantContextValue } from "@/lib/tenant/tenant-context";

const { mockUseTenant, mockNotFound } = vi.hoisted(() => ({
  mockUseTenant: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/tenant/tenant-context", () => ({
  useTenant: () => mockUseTenant(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
}));

vi.mock("./tenant-unavailable", () => ({
  TenantUnavailable: () => <div>tenant-unavailable</div>,
}));

const READY: TenantContextValue = {
  status: "ready",
  organization: { slug: "default", name: "Default" },
  workspaces: [{ slug: "default", name: "Default", isDefault: true }],
  retry: () => {},
};

describe("TenantScopeGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when the slugs match", () => {
    mockUseTenant.mockReturnValue(READY);

    render(
      <TenantScopeGuard orgSlug="default" workspaceSlug="default">
        <div>child</div>
      </TenantScopeGuard>,
    );

    expect(screen.getByText("child")).toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("404s on a mismatched org slug", () => {
    mockUseTenant.mockReturnValue(READY);

    expect(() =>
      render(
        <TenantScopeGuard orgSlug="acme">
          <div>child</div>
        </TenantScopeGuard>,
      ),
    ).toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });

  it("404s on a workspace the org does not own", () => {
    mockUseTenant.mockReturnValue(READY);

    expect(() =>
      render(
        <TenantScopeGuard orgSlug="default" workspaceSlug="ghost">
          <div>child</div>
        </TenantScopeGuard>,
      ),
    ).toThrow("NEXT_NOT_FOUND");
  });

  it("renders the fallback, not children, while loading", () => {
    mockUseTenant.mockReturnValue({ status: "loading", retry: () => {} });

    render(
      <TenantScopeGuard orgSlug="default" workspaceSlug="default">
        <div>child</div>
      </TenantScopeGuard>,
    );

    expect(screen.queryByText("child")).not.toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("renders TenantUnavailable when the tenancy cannot be established", () => {
    mockUseTenant.mockReturnValue({ status: "no-organization", retry: () => {} });

    render(
      <TenantScopeGuard orgSlug="default">
        <div>child</div>
      </TenantScopeGuard>,
    );

    expect(screen.getByText("tenant-unavailable")).toBeInTheDocument();
    expect(screen.queryByText("child")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @polyant/web -- tenant-scope-guard`
Expected: FAIL — cannot resolve `./tenant-scope-guard`.

- [ ] **Step 3: Write the guard**

Create `packages/web/src/components/layout/tenant-scope-guard.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { notFound } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { useTenant } from "@/lib/tenant/tenant-context";
import { validateTenantParams } from "@/lib/tenant/validate";
import { TenantUnavailable } from "./tenant-unavailable";

/**
 * Gates a tenant-scoped subtree. Children never mount with unvalidated params:
 * until the tenancy is known we render a skeleton, and a URL addressing someone
 * else's tenant is a 404 rather than a page wrapped in the wrong chrome.
 */
export function TenantScopeGuard({
  orgSlug,
  workspaceSlug,
  children,
}: {
  orgSlug: string;
  workspaceSlug?: string;
  children: React.ReactNode;
}) {
  const tenant = useTenant();

  if (tenant.status === "loading") {
    return <Skeleton className="h-64 w-full" />;
  }

  if (tenant.status !== "ready") {
    return <TenantUnavailable />;
  }

  const scope = { organization: tenant.organization, workspaces: tenant.workspaces };
  if (!validateTenantParams(scope, orgSlug, workspaceSlug)) {
    notFound();
  }

  return <>{children}</>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @polyant/web -- tenant-scope-guard`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/t5.txt <<'EOF'
feat(web): add TenantScopeGuard

Children never mount with unvalidated params: a skeleton while the tenancy
resolves, TenantUnavailable when it cannot, notFound() when the URL addresses
a tenant that is not the caller's.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/web/src/components/layout
git commit -F /tmp/t5.txt
```

---

### Task 6: Web — move the routes, add the nested layouts, keep legacy URLs working

**Files:**
- Move (`git mv`): 7 directories + `(admin)/page.tsx` — exact commands in Step 2
- Create: `(admin)/organizations/[orgSlug]/layout.tsx`
- Create: `(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/layout.tsx`
- Create: `(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/page.tsx`
- Create: `(admin)/page.tsx` (new resolver, replaces the moved dashboard)
- Create: `packages/web/src/components/layout/legacy-tenant-redirect.tsx`
- Create: 9 legacy stub pages at the old locations (Step 6)
- Modify: `(admin)/organizations/[orgSlug]/members/page.tsx` (read `orgSlug` from the route)
- Modify: `packages/web/src/lib/api.ts` (delete `DEFAULT_ORG_SLUG`, make `orgSlug` required)

**Interfaces:**
- Consumes: `orgPath` / `workspacePath` (Task 2), `useTenant` / `defaultWorkspaceSlug` (Task 4), `TenantScopeGuard` (Task 5), `TenantUnavailable` (Task 4).
- Produces: `<LegacyTenantRedirect sub={string} scope?={"workspace" | "org"} />`; the route tree the remaining tasks link into; `api.members.list(orgSlug: string)`, `api.members.assign(userId: string, roleKey: string, orgSlug: string)`, `api.members.remove(userId: string, orgSlug: string)` — all with `orgSlug` REQUIRED.

The nested layouts are server components that `await params` and hand plain strings to the client guard. The workspace index page redirects server-side — the slugs come from the URL and the layout above it already validated them, so it needs no tenant fetch.

**Do NOT use shell variables in the `git mv` commands.** Paths contain `(` and `[`, so every path must be quoted literally.

- [ ] **Step 1: Confirm the pre-move state**

Run: `ls "packages/web/src/app/(admin)"`
Expected: `activity audit-logs conversations error.test.tsx error.tsx instances layout.tsx members memory page.tsx playground settings skills`

- [ ] **Step 2: Move the directories**

```bash
mkdir -p "packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]"
git mv "packages/web/src/app/(admin)/page.tsx" "packages/web/src/app/(admin)/organizations/[orgSlug]/page.tsx"
git mv "packages/web/src/app/(admin)/members" "packages/web/src/app/(admin)/organizations/[orgSlug]/members"
git mv "packages/web/src/app/(admin)/audit-logs" "packages/web/src/app/(admin)/organizations/[orgSlug]/audit-logs"
git mv "packages/web/src/app/(admin)/instances" "packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/instances"
git mv "packages/web/src/app/(admin)/conversations" "packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/conversations"
git mv "packages/web/src/app/(admin)/playground" "packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/playground"
git mv "packages/web/src/app/(admin)/activity" "packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/activity"
git mv "packages/web/src/app/(admin)/memory" "packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/memory"
```

Verify rename detection held (no file should appear as delete+add):

Run: `git status --porcelain | grep -c '^R'`
Expected: a count in the dozens (every moved file), and `git status --porcelain | grep '^A\|^D' | head` prints nothing.

`settings/` and `skills/` stay where they are — they are deployment-level. `error.tsx` and `layout.tsx` stay at the admin root.

- [ ] **Step 3: Add the two nested layouts and the workspace index**

Create `packages/web/src/app/(admin)/organizations/[orgSlug]/layout.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { TenantScopeGuard } from "@/components/layout/tenant-scope-guard";

/**
 * Organization-scoped subtree. A server component so it can await `params` and
 * hand the guard plain strings.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return <TenantScopeGuard orgSlug={orgSlug}>{children}</TenantScopeGuard>;
}
```

Create `packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/layout.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { TenantScopeGuard } from "@/components/layout/tenant-scope-guard";

/** Workspace-scoped subtree — validates both segments. */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  return (
    <TenantScopeGuard orgSlug={orgSlug} workspaceSlug={workspaceSlug}>
      {children}
    </TenantScopeGuard>
  );
}
```

Create `packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { redirect } from "next/navigation";
import { workspacePath } from "@/lib/tenant/paths";

/**
 * A workspace has no landing page of its own — the agents list is its home.
 * Redirects server-side: the slugs come from the URL and the layout above has
 * already validated them, so no tenant fetch is needed.
 */
export default async function WorkspaceIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspacePath(orgSlug, workspaceSlug, "/instances"));
}
```

- [ ] **Step 4: Add the new root resolver**

Create `packages/web/src/app/(admin)/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantUnavailable } from "@/components/layout/tenant-unavailable";
import { useTenant } from "@/lib/tenant/tenant-context";
import { orgPath } from "@/lib/tenant/paths";

/**
 * The single place that resolves "where does this user land". Every legacy
 * redirect and the Auth.js `Response.redirect(new URL("/"))` targets converge
 * here, which is why the Edge middleware never needs tenancy knowledge (it
 * could not obtain it — no DB access in the Edge runtime).
 */
export default function AdminRootPage() {
  const tenant = useTenant();
  const router = useRouter();

  useEffect(() => {
    if (tenant.status === "ready") {
      router.replace(orgPath(tenant.organization.slug));
    }
  }, [tenant, router]);

  if (tenant.status === "loading" || tenant.status === "ready") {
    return <Skeleton className="h-64 w-full" />;
  }
  return <TenantUnavailable />;
}
```

- [ ] **Step 5: Add the legacy redirect component**

Create `packages/web/src/components/layout/legacy-tenant-redirect.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { TenantUnavailable } from "./tenant-unavailable";
import { useTenant, defaultWorkspaceSlug } from "@/lib/tenant/tenant-context";
import { orgPath, workspacePath } from "@/lib/tenant/paths";

/**
 * Forwards a pre-tenancy URL to its canonical form, preserving the query string
 * (`/conversations?id=…` is a real inbound link). Deep links are what people
 * bookmark, so these stubs exist for one release before removal.
 */
export function LegacyTenantRedirect({
  sub,
  scope = "workspace",
}: {
  sub: string;
  scope?: "workspace" | "org";
}) {
  const tenant = useTenant();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (tenant.status !== "ready") return;

    const query = searchParams.toString();
    const suffix = query ? `${sub}?${query}` : sub;

    if (scope === "org") {
      router.replace(orgPath(tenant.organization.slug, suffix));
      return;
    }

    const workspaceSlug = defaultWorkspaceSlug(tenant);
    if (!workspaceSlug) return;
    router.replace(workspacePath(tenant.organization.slug, workspaceSlug, suffix));
  }, [tenant, router, searchParams, sub, scope]);

  if (tenant.status === "loading" || tenant.status === "ready") {
    return <Skeleton className="h-64 w-full" />;
  }
  return <TenantUnavailable />;
}
```

- [ ] **Step 6: Add the nine legacy stub pages**

Each is a whole file. Create them exactly:

`packages/web/src/app/(admin)/instances/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyInstancesPage() {
  return <LegacyTenantRedirect sub="/instances" />;
}
```

`packages/web/src/app/(admin)/instances/[slug]/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useParams } from "next/navigation";
import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyInstanceDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  return <LegacyTenantRedirect sub={`/instances/${encodeURIComponent(slug)}`} />;
}
```

`packages/web/src/app/(admin)/conversations/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyConversationsPage() {
  return <LegacyTenantRedirect sub="/conversations" />;
}
```

`packages/web/src/app/(admin)/conversations/[conversationId]/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useParams } from "next/navigation";
import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyConversationDetailPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return (
    <LegacyTenantRedirect sub={`/conversations/${encodeURIComponent(conversationId)}`} />
  );
}
```

`packages/web/src/app/(admin)/playground/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyPlaygroundPage() {
  return <LegacyTenantRedirect sub="/playground" />;
}
```

`packages/web/src/app/(admin)/activity/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyActivityPage() {
  return <LegacyTenantRedirect sub="/activity" />;
}
```

`packages/web/src/app/(admin)/memory/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyMemoryPage() {
  return <LegacyTenantRedirect sub="/memory" />;
}
```

`packages/web/src/app/(admin)/members/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyMembersPage() {
  return <LegacyTenantRedirect sub="/members" scope="org" />;
}
```

`packages/web/src/app/(admin)/audit-logs/page.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyAuditLogsPage() {
  return <LegacyTenantRedirect sub="/audit-logs" scope="org" />;
}
```

- [ ] **Step 7: Make `orgSlug` required in the members API client**

In `packages/web/src/lib/api.ts`, delete the `DEFAULT_ORG_SLUG` export (the doc comment at lines 123–128 goes with it) and replace the `members` block with:

```ts
  members: {
    list: (orgSlug: string) =>
      request<{ members: OrganizationMember[] }>(
        `/api/organizations/${encodeURIComponent(orgSlug)}/members`,
      ),
    assign: (userId: string, roleKey: string, orgSlug: string) =>
      request<{ assigned: boolean }>(
        `/api/organizations/${encodeURIComponent(orgSlug)}/members/${encodeURIComponent(userId)}`,
        { method: "PUT", body: JSON.stringify({ roleKey }) },
      ),
    remove: (userId: string, orgSlug: string) =>
      request<{ removed: boolean }>(
        `/api/organizations/${encodeURIComponent(orgSlug)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),
  },
```

- [ ] **Step 8: Feed the route param to the members page**

In `packages/web/src/app/(admin)/organizations/[orgSlug]/members/page.tsx`, add the import:

```tsx
import { useParams } from "next/navigation";
```

Inside `MembersPage`, read the slug right after `const { t } = useI18n();`:

```tsx
  const { orgSlug } = useParams<{ orgSlug: string }>();
```

Then pass it at the three call sites: `api.members.list(orgSlug)` inside `fetchMembers`, `api.members.assign(member.userId, roleKey, orgSlug)` inside `handleRoleChange`, and `api.members.remove(member.userId, orgSlug)` in the removal handler. Add `orgSlug` to the `useCallback` dependency array of `fetchMembers` (it becomes `[t, orgSlug]`).

- [ ] **Step 9: Verify nothing else referenced the deleted constant**

Run: `grep -rn "DEFAULT_ORG_SLUG" packages/web/src`
Expected: no output.

Run: `npm run typecheck -w @polyant/web`
Expected: clean. If a moved page test fails to resolve an import, the move dragged a test whose relative import escaped its subtree — re-check with `grep -rn "from \"\.\./\.\./\.\." "packages/web/src/app/(admin)/organizations"`.

- [ ] **Step 10: Run the web suite**

Run: `npm test -w @polyant/web`
Expected: PASS. Task 8 fixes the tests that break on `useParams`; if any moved page test fails HERE with "useParams is not a function", note the file and leave it — Task 8 owns it. Everything else must be green.

- [ ] **Step 11: Commit**

```bash
cat > /tmp/t6.txt <<'EOF'
feat(web): move admin routes under the tenant path

Three tiers, each URL truthful about its real scope: workspace-level for the
agents and their data, org-level for the dashboard (analytics are org-wide),
members and audit logs, deployment-level for settings and skills, which stay
flat.

Legacy flat URLs live on as redirect stubs, deep links included, since those
are the ones people bookmark. They are removable in one release. auth.config.ts
needs no change: "/" is now the resolver, so the Edge middleware still never
needs tenancy knowledge.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add -A packages/web/src
git commit -F /tmp/t6.txt
```

---

### Task 7: Web — scope-aware sidebar navigation

**Files:**
- Create: `packages/web/src/lib/tenant/nav-href.ts`
- Create: `packages/web/src/lib/tenant/nav-href.test.ts`
- Modify: `packages/web/src/components/layout/nav-main.tsx` (add the `exact` flag)
- Modify: `packages/web/src/components/layout/nav-main.test.tsx` (cover `exact`)
- Modify: `packages/web/src/components/layout/app-sidebar.tsx`

**Interfaces:**
- Consumes: `orgPath` / `workspacePath` (Task 2), `useTenant` / `defaultWorkspaceSlug` (Task 4).
- Produces: `NavScope = "workspace" | "org" | "deployment"`; `NavScopeContext = { orgSlug: string | null; workspaceSlug: string | null }`; `navHref(scope: NavScope, path: string, ctx: NavScopeContext): string`; `isNavActive(pathname: string, url: string, exact?: boolean): boolean`.

The href logic is a pure function so it can be tested without rendering the whole sidebar (which would mean mocking the sidebar primitives, i18n, the tenant context and the router at once). When the tenancy is unresolved, tenant-scoped items point at `/` — clicking still lands correctly because `/` is the resolver, and no item ever disappears and reappears.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/tenant/nav-href.test.ts`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { navHref } from "./nav-href";

const RESOLVED = { orgSlug: "default", workspaceSlug: "general" };

describe("navHref", () => {
  it("passes a deployment-level path through untouched", () => {
    expect(navHref("deployment", "/settings", RESOLVED)).toBe("/settings");
  });

  it("does not need a tenant for a deployment-level path", () => {
    expect(navHref("deployment", "/skills", { orgSlug: null, workspaceSlug: null })).toBe(
      "/skills",
    );
  });

  it("builds an org-level path", () => {
    expect(navHref("org", "/members", RESOLVED)).toBe("/organizations/default/members");
  });

  it("builds the org root for an empty path (the dashboard)", () => {
    expect(navHref("org", "", RESOLVED)).toBe("/organizations/default");
  });

  it("builds a workspace-level path", () => {
    expect(navHref("workspace", "/instances", RESOLVED)).toBe(
      "/organizations/default/workspaces/general/instances",
    );
  });

  it("falls back to the resolver when the org is unknown", () => {
    expect(navHref("org", "/members", { orgSlug: null, workspaceSlug: null })).toBe("/");
  });

  it("falls back to the resolver when the workspace is unknown", () => {
    expect(navHref("workspace", "/instances", { orgSlug: "default", workspaceSlug: null })).toBe(
      "/",
    );
  });
});
```

Append to `packages/web/src/components/layout/nav-main.test.tsx`:

```tsx
describe("isNavActive with exact", () => {
  it("matches only the exact path when exact is set", () => {
    expect(isNavActive("/organizations/default", "/organizations/default", true)).toBe(true);
    expect(
      isNavActive("/organizations/default/members", "/organizations/default", true),
    ).toBe(false);
  });

  it("still matches sub-routes when exact is not set", () => {
    expect(isNavActive("/organizations/default/members", "/organizations/default")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @polyant/web -- nav-href nav-main`
Expected: FAIL — cannot resolve `./nav-href`; and `isNavActive` ignores its third argument, so the exact case returns `true` where `false` is expected.

- [ ] **Step 3: Write the pure href builder**

Create `packages/web/src/lib/tenant/nav-href.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { orgPath, workspacePath } from "./paths";

/** Which tier of the hierarchy a navigation entry belongs to. */
export type NavScope = "workspace" | "org" | "deployment";

/** The tenancy known at render time. Either slug may be absent. */
export interface NavScopeContext {
  orgSlug: string | null;
  workspaceSlug: string | null;
}

/**
 * Build a navigation href for a scope. When the tenancy is not yet resolved a
 * tenant-scoped entry points at `/` — the resolver forwards to the right place,
 * so links stay clickable instead of vanishing and reappearing.
 */
export function navHref(scope: NavScope, path: string, ctx: NavScopeContext): string {
  if (scope === "deployment") return path;
  if (!ctx.orgSlug) return "/";
  if (scope === "org") return orgPath(ctx.orgSlug, path);
  if (!ctx.workspaceSlug) return "/";
  return workspacePath(ctx.orgSlug, ctx.workspaceSlug, path);
}
```

- [ ] **Step 4: Add the `exact` flag**

In `packages/web/src/components/layout/nav-main.tsx`, extend the interface and the matcher:

```ts
export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  exact?: boolean;
}

// Segment-aware active match: `/audit` must NOT match `/audit-logs`, but
// `/audit-logs` must still match its own sub-routes (`/audit-logs/123`).
// `exact` opts out of the sub-route match — the dashboard sits at the org root,
// which is a prefix of every other org route.
export function isNavActive(pathname: string, url: string, exact = false): boolean {
  if (exact || url === "/") return pathname === url;
  return pathname === url || pathname.startsWith(url + "/");
}
```

and pass the flag at the call site inside `NavMain`:

```tsx
            const isActive = isNavActive(pathname, item.url, item.exact);
```

- [ ] **Step 5: Rewire the sidebar**

In `packages/web/src/components/layout/app-sidebar.tsx`, add these imports:

```tsx
import { useCallback } from "react";
import { useParams } from "next/navigation";
import { navHref, type NavScope } from "@/lib/tenant/nav-href";
import { useTenant, defaultWorkspaceSlug } from "@/lib/tenant/tenant-context";
```

Replace the `NavItemDef` interface and both definition arrays with:

```tsx
interface NavItemDef {
  titleKey: TranslationKey;
  /** Path suffix within its scope — "" is the scope root. */
  path: string;
  scope: NavScope;
  icon: LucideIcon;
  exact?: boolean;
}

const overviewDefs: NavItemDef[] = [
  { titleKey: "nav.dashboard", path: "", scope: "org", exact: true, icon: LayoutDashboard },
  { titleKey: "nav.instances", path: "/instances", scope: "workspace", icon: Bot },
  { titleKey: "nav.conversations", path: "/conversations", scope: "workspace", icon: MessageSquare },
  { titleKey: "nav.playground", path: "/playground", scope: "workspace", icon: MessageSquareCode },
  { titleKey: "nav.activity", path: "/activity", scope: "workspace", icon: Activity },
  { titleKey: "nav.memory", path: "/memory", scope: "workspace", icon: Brain },
  // The skill catalog is global — it is NOT workspace-scoped yet, so its URL
  // must not pretend otherwise. See the workspace-scoped-skills spec.
  { titleKey: "nav.skills", path: "/skills", scope: "deployment", icon: Zap },
  { titleKey: "nav.auditLogs", path: "/audit-logs", scope: "org", icon: ScrollText },
];

// Settings is superadmin-only: it hosts both general system settings and the
// users management tab. Non-superadmins don't see this section at all.
const superadminDefs: NavItemDef[] = [
  { titleKey: "nav.members", path: "/members", scope: "org", icon: Users },
  { titleKey: "nav.settings", path: "/settings", scope: "deployment", icon: Settings },
];
```

Inside `AppSidebar`, replace the `toNavItems` definition with a tenancy-aware one:

```tsx
  const tenant = useTenant();
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();

  // Prefer the tenant the URL is already addressing; fall back to the caller's
  // own organization and its default workspace so workspace-scope items stay
  // clickable from deployment-level pages like /settings.
  //
  // Both slugs are plain strings, NOT a wrapper object: an object literal is a
  // new reference every render, so exhaustive-deps would reject it as a
  // dependency (and memoising it would only move the problem).
  const orgSlug =
    params.orgSlug ?? (tenant.status === "ready" ? tenant.organization.slug : null);
  const workspaceSlug = params.workspaceSlug ?? defaultWorkspaceSlug(tenant);

  const toNavItems = useCallback(
    (defs: NavItemDef[]): NavItem[] =>
      defs.map((d) => ({
        title: t(d.titleKey),
        url: navHref(d.scope, d.path, { orgSlug, workspaceSlug }),
        icon: d.icon,
        exact: d.exact,
      })),
    [t, orgSlug, workspaceSlug],
  );
```

Keep the rest of the component unchanged.

- [ ] **Step 6: Run the tests**

Run: `npm test -w @polyant/web -- nav-href nav-main`
Expected: PASS — 7 + 5 tests.

- [ ] **Step 7: Verify the suite and typecheck**

Run: `npm run typecheck -w @polyant/web && npm test -w @polyant/web`
Expected: clean and PASS. If a test renders `AppSidebar` (or the admin layout) without `TenantProvider`, it now throws `useTenant must be used within TenantProvider` — wrap the render in `<TenantProvider>` or mock `@/lib/tenant/tenant-context` in that file.

- [ ] **Step 8: Commit**

```bash
cat > /tmp/t7.txt <<'EOF'
feat(web): make sidebar navigation scope-aware

Each nav entry declares its tier and its href is built from the addressed
tenant, falling back to the caller's own org and default workspace so
workspace items stay clickable from /settings.

The dashboard needs the new `exact` flag: it now sits at the org root, which
is a prefix of every other org route, so the old startsWith match would light
it up everywhere.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/web/src/lib/tenant packages/web/src/components/layout
git commit -F /tmp/t7.txt
```

---

### Task 8: Web — rewrite the in-code links

**Files:**
- Create: `packages/web/src/lib/tenant/use-tenant-paths.ts`
- Modify (all under `packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/`):
  - `conversations/[conversationId]/page.tsx` (4 sites)
  - `conversations/page.tsx` (1 site)
  - `instances/page.tsx` (3 sites)
  - `instances/[slug]/page.tsx` (3 sites)
  - `instances/create-instance-dialog.tsx` (1 site)
  - `instances/[slug]/scheduled-task-runs-section.tsx` (1 site)
  - `instances/[slug]/triggers-runs-tab.tsx` (1 site)
- Modify: the test files that break on `useParams` (Step 4)

**Interfaces:**
- Consumes: `orgPath` / `workspacePath` (Task 2).
- Produces: `useTenantPaths(): { workspace: (sub: string) => string; org: (sub?: string) => string }`.

Every one of these 14 sites lives INSIDE a workspace route, so both slugs are in the URL synchronously and the hook needs no tenant fetch and has no null case. Leave the `skills/*` links flat and the `href={`/api/attachments/…`}` sites alone — those are API URLs, not routes.

- [ ] **Step 1: Write the hook**

Create `packages/web/src/lib/tenant/use-tenant-paths.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { orgPath, workspacePath } from "./paths";

export interface TenantPaths {
  workspace: (sub: string) => string;
  org: (sub?: string) => string;
}

/**
 * Tenant paths for components that already live inside a workspace route: both
 * slugs are present in the URL synchronously, and the layout guard above has
 * already validated them. No fetch, no null case.
 */
export function useTenantPaths(): TenantPaths {
  const { orgSlug, workspaceSlug } = useParams<{
    orgSlug: string;
    workspaceSlug: string;
  }>();

  return useMemo(
    () => ({
      workspace: (sub: string) => workspacePath(orgSlug, workspaceSlug, sub),
      org: (sub?: string) => orgPath(orgSlug, sub),
    }),
    [orgSlug, workspaceSlug],
  );
}
```

- [ ] **Step 2: Rewrite the link sites**

In each file add the import and call the hook inside the component body (alongside the existing `useI18n()` / `useRouter()` calls):

```tsx
import { useTenantPaths } from "@/lib/tenant/use-tenant-paths";
```
```tsx
  const paths = useTenantPaths();
```

Then apply these exact replacements. Line numbers are pre-edit; match on the code, not the number.

`conversations/[conversationId]/page.tsx` — 4 sites:
- `router.push("/conversations");` (twice, ~238 and ~401) → `router.push(paths.workspace("/conversations"));`
- `router.push(`/conversations/${encodeURIComponent(nextId)}`);` (~386) → `router.push(paths.workspace(`/conversations/${encodeURIComponent(nextId)}`));`
- `<Link href="/conversations">` (~430) → `<Link href={paths.workspace("/conversations")}>`

`conversations/page.tsx` — 1 site (~179):
- `href={`/conversations/${encodeURIComponent(conv.conversationId)}`}` → `href={paths.workspace(`/conversations/${encodeURIComponent(conv.conversationId)}`)}`

`instances/page.tsx` — 3 sites (~78, ~136 hrefs; ~211 push):
- `href={`/instances/${inst.slug}`}` → `href={paths.workspace(`/instances/${encodeURIComponent(inst.slug)}`)}`
- `router.push(`/instances/${result.slug}`);` → `router.push(paths.workspace(`/instances/${encodeURIComponent(result.slug)}`));`

`instances/[slug]/page.tsx` — 3 sites (~112, ~121 pushes; ~166 Link). Leave line ~87 (`router.push(`${pathname}?${next.toString()}`)`) untouched — it is already relative to the current path:
- `router.push("/instances");` → `router.push(paths.workspace("/instances"));`
- `<Link href="/instances">` → `<Link href={paths.workspace("/instances")}>`

`instances/create-instance-dialog.tsx` — 1 site (~70):
- `router.push(`/instances/${instance.slug}`);` → `router.push(paths.workspace(`/instances/${encodeURIComponent(instance.slug)}`));`

`instances/[slug]/scheduled-task-runs-section.tsx` — 1 site (~291):
- `href={`/conversations/${encodeURIComponent(run.conversationId)}`}` → `href={paths.workspace(`/conversations/${encodeURIComponent(run.conversationId)}`)}`

`instances/[slug]/triggers-runs-tab.tsx` — 1 site (~143):
- `href={`/conversations?id=${encodeURIComponent(conv.conversationId)}`}` → `href={paths.workspace(`/conversations?id=${encodeURIComponent(conv.conversationId)}`)}`

Slugs gain `encodeURIComponent` where it was missing — a slug is `[a-z0-9-]` today, so this changes no output, but it stops the helper being the one place that trusts input.

- [ ] **Step 3: Verify no flat route link survives**

Run:
```bash
grep -rnE 'href="/(instances|conversations|playground|activity|memory|members|audit-logs)|push\("/(instances|conversations|playground|activity|memory)' "packages/web/src/app/(admin)/organizations"
```
Expected: no output.

- [ ] **Step 4: Fix the tests that now need `useParams`**

Run: `npm test -w @polyant/web`

Every failure of the form `useParams is not a function` (or a component rendering an empty href) is a test whose `next/navigation` mock is now incomplete. `create-instance-dialog.test.tsx` already mocks the module — add `useParams` to that mock. For a file with NO `next/navigation` mock, add one:

```tsx
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ orgSlug: "default", workspaceSlug: "general" }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/organizations/default/workspaces/general/instances",
}));
```

If a mock already exists, add only the missing keys — do not replace a mock that a test asserts against (e.g. a captured `push` spy).

Update any assertion that expects a flat href to the canonical one, e.g. `"/instances/support-bot"` becomes `"/organizations/default/workspaces/general/instances/support-bot"`.

- [ ] **Step 5: Verify green**

Run: `npm run typecheck -w @polyant/web && npm test -w @polyant/web`
Expected: clean and PASS.

- [ ] **Step 6: Commit**

```bash
cat > /tmp/t8.txt <<'EOF'
refactor(web): route in-code links through the tenant path helpers

The 14 link sites all live inside workspace routes, so useTenantPaths reads
both slugs from the URL synchronously — no fetch and no null case, because the
layout guard above has already validated them.

Skill links stay flat (the catalog is global) and /api/attachments hrefs are
API URLs, not routes.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/web/src
git commit -F /tmp/t8.txt
```

---

### Task 9: E2E coverage and the full verification sweep

**Files:**
- Create: `packages/web/e2e/rbac/tenant-urls.spec.ts`
- Modify: `packages/web/e2e/README.md` (add the row to the layout table)

**Interfaces:**
- Consumes: the whole route tree (Tasks 6–8), `loginAs` from `../fixtures/auth.js`, `getTestUser` from `../setup/test-env.js`.
- Produces: nothing — this is the outermost check.

The harness boots the engine with `AUTHZ_ENFORCE=true`, so this suite also proves `GET /api/me` is reachable under enforcement by all three roles (Viewer included — it holds `ORG_READ`). Playwright specs use `.js` import extensions.

**The seeded slugs are asymmetric**: organization `default`, workspace **`general`** (migration 0051). Use that exact pair.

- [ ] **Step 1: Write the spec**

Create `packages/web/e2e/rbac/tenant-urls.spec.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tenant-scoped URL routing, end to end against a real engine + DB.
 *
 * The harness runs with AUTHZ_ENFORCE=true, so these tests also prove
 * GET /api/me is reachable under enforcement for every role — a Viewer holds
 * ORG_READ, and a route that declared no permission would 403 here.
 *
 * Migration 0051 seeds the organization as "default" and the workspace as
 * "general" — the slugs are deliberately not the same word.
 */

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/auth.js";

const ORG_SLUG = "default";
const WORKSPACE_SLUG = "general";
const CANONICAL_AGENTS = `/organizations/${ORG_SLUG}/workspaces/${WORKSPACE_SLUG}/instances`;

test.describe("tenant-scoped URLs", () => {
  test("the root path resolves to the organization dashboard", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto("/");

    await page.waitForURL(`**/organizations/${ORG_SLUG}`, { timeout: 20_000 });
  });

  test("a legacy flat URL forwards to its canonical form", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto("/instances");

    await page.waitForURL(`**${CANONICAL_AGENTS}`, { timeout: 20_000 });
  });

  test("a legacy deep link keeps its query string", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto("/conversations?id=does-not-exist");

    await page.waitForURL(
      (url) =>
        url.pathname ===
          `/organizations/${ORG_SLUG}/workspaces/${WORKSPACE_SLUG}/conversations` &&
        url.searchParams.get("id") === "does-not-exist",
      { timeout: 20_000 },
    );
  });

  test("the canonical workspace URL renders the agents page", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto(CANONICAL_AGENTS);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(CANONICAL_AGENTS);
  });

  test("an unknown organization slug is a 404", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto(`/organizations/ghost/workspaces/${WORKSPACE_SLUG}/instances`);

    await expect(page.locator("body")).toContainText(/could not be found/i);
  });

  test("an unknown workspace slug is a 404", async ({ page }) => {
    await loginAs(page, "owner");

    await page.goto(`/organizations/${ORG_SLUG}/workspaces/ghost/instances`);

    await expect(page.locator("body")).toContainText(/could not be found/i);
  });

  test("a Viewer can still resolve their tenancy under enforcement", async ({ page }) => {
    await loginAs(page, "viewer");

    await page.goto("/");

    // Reaching the dashboard means GET /api/me returned 200 with AUTHZ_ENFORCE=true.
    await page.waitForURL(`**/organizations/${ORG_SLUG}`, { timeout: 20_000 });
  });
});
```

- [ ] **Step 2: Run the e2e suite**

Prerequisites (skip any already satisfied): `docker compose up -d postgres` and `npx playwright install chromium`.

Run: `npm run test:e2e -w @polyant/web -- tenant-urls`
Expected: 7 tests PASS.

If the 404 assertions fail because Next renders a custom not-found page, read what it actually renders and match that text instead — do not weaken the assertion to something that would also pass on a successfully-rendered page.

- [ ] **Step 3: Document the new spec**

In `packages/web/e2e/README.md`, add a row to the layout table next to the existing `rbac/members-access.spec.ts` entry:

```markdown
| `rbac/tenant-urls.spec.ts` | Tenant-scoped URL routing: root resolution, legacy redirects, 404 on foreign slugs. |
```

- [ ] **Step 4: Full sweep across both packages**

Run each and require a clean result:

```bash
npm run typecheck
npm run lint
npm run test:unit -w @polyant/engine
npm test -w @polyant/web
npm run test:e2e -w @polyant/web
```

Expected: typecheck clean, lint clean, all three suites PASS.

- [ ] **Step 5: Verify the tenancy claim by hand**

Start the stack (`npm run dev` and `npm run dev:web`), sign in, and confirm:

1. `/` lands on `/organizations/default`.
2. The sidebar's agent entries point at `/organizations/default/workspaces/general/…`.
3. `/settings` and `/skills` are still flat and still load.
4. Editing the URL to `/organizations/ghost/workspaces/general/instances` shows a 404.
5. Stopping the engine and reloading a tenant page shows the retry state, while `/settings` keeps working — the provider must not block the shell.

- [ ] **Step 6: Commit**

```bash
cat > /tmp/t9.txt <<'EOF'
test(web): cover tenant-scoped URL routing end to end

Root resolution, legacy redirects including query-string preservation, and a
404 on a foreign org or workspace slug. Because the harness enforces RBAC, the
Viewer case also proves GET /api/me is reachable under AUTHZ_ENFORCE=true — a
route declaring no permission would 403 there.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/web/e2e
git commit -F /tmp/t9.txt
```

---

## Deferred, with an owner

These are named in the spec as out of scope. Do NOT let them creep into this plan:

- **Removing the legacy stubs** after one release — open a follow-up issue when Task 6 lands, otherwise the stubs become permanent.
- **Workspace-scoped skills** — needs `workspace_id` on `skills`, a backfill, query scoping, and a way for the workspace to reach the request. Own spec.
- **Tenant-scoped API paths** mirroring these frontend paths — the agreed direct successor, and what turns the decorative workspace segment into a real one.
- **`/platform/*` console and Super Admin UI** — prefix reserved by `PLATFORM_PREFIX`, nothing built.
- **Organization and workspace CRUD plus a switcher** — the provider already exposes `workspaces[]`, so the switcher is later a UI-only addition.
