# Tenant-scoped frontend URLs — design

**Date:** 2026-07-28
**Status:** approved (brainstorming) — implementation pending
**Scope:** `packages/web` routing + one new engine endpoint (`GET /api/me`)
**Successor specs (agreed, not yet written):** workspace-scoped skills;
tenant-scoped **API** paths mirroring these frontend paths

## 1. Problem

Migration 0051 shipped the `Organization > Workspace > Agent` tenancy schema and
its RBAC, but the admin panel is unaware of it. Every route is flat
(`/instances`, `/conversations`, …) and `packages/web/src/lib/api.ts` hardcodes
`DEFAULT_ORG_SLUG = "default"` to address the only organization that exists.

We want the frontend URLs to carry the tenancy hierarchy —
`/organizations/{orgSlug}/workspaces/{workspaceSlug}/…` — so that the refactor
is paid once, links are canonical and shareable, and the hardcoded org slug
disappears.

## 2. What org and workspace mean in the API today

This is the load-bearing fact behind every decision below, so it is recorded
here rather than left to be rediscovered.

Neither identifier is part of the request contract in any meaningful way:

1. **In the path — exactly one route:** `/api/organizations/:orgSlug/members`.
   No route anywhere names the workspace.
2. **On the principal (implicit):** a human user carries an `orgId` claim in the
   Auth.js JWT, stamped at sign-in by the `jwt` callback in
   `packages/web/src/lib/auth.ts`; a management API key (`X-Polyant-Key`)
   carries `orgId` on its own row; a per-instance API key is bound to its agent.
   The client sends none of this explicitly.
3. **Derived from the resource:** for routes carrying `:slug`,
   `resolveAgentScope(slug)` joins `instances → workspaces` to produce
   `{ agentId, workspaceId, organizationId }`. It is the single slug→tenancy
   choke-point. For routes **without** `:slug` the scope is the caller's org
   with `workspaceId: ""`, so workspace-scoped role bindings do not apply to
   them at all.
4. **Not writable:** `instances/store.ts` always writes
   `findDefaultWorkspaceId()`. No API can place an agent in another workspace,
   and no workspace endpoint exists.

Cross-org isolation is `principal.orgId !== scope.organizationId → deny`, plus
the `:orgSlug` re-resolution inside `MembersService`.

**Consequence:** in this phase the workspace segment is **decorative**. Nothing
in the backend reads it, and `workspaceId: ""` in the guard is unchanged. A
workspace-scoped URL isolates nothing. This is deliberate — the successor spec
that reshapes the API paths is what gives the segment meaning.

## 3. Decisions

| Question | Decision |
|---|---|
| Goal of this spec | Canonical URLs only. No new user-facing capability. |
| Segments | Both, `workspaceSlug` fixed to `default`. |
| Route partitioning | Three tiers, each URL truthful about its real scope. |
| Slug source | New `GET /api/me` in the engine. |
| Mechanism | Real dynamic segments (directory move), client-side validation. |
| Skills | Stay deployment-level here; own spec later. |

Rejected: rewriting tenant paths onto a flat filesystem in `proxy.ts` (URL and
filesystem diverge forever, `useParams` returns nothing, active-nav matching
becomes a puzzle). Rejected: server-side validation in an async layout — it is
architecturally cleaner but would introduce the first server→engine fetch in
`packages/web` (absolute `ENGINE_URL` + manual cookie forwarding + a rewrite
bypass) for a benefit that is invisible with a single organization.

## 4. Route map

```
(admin)/
  page.tsx                                → client component: resolve tenant, redirect to /organizations/{org}
  organizations/[orgSlug]/
    page.tsx                              → dashboard (analytics are org-wide)
    members/
    audit-logs/
    workspaces/[workspaceSlug]/
      page.tsx                            → redirect to ./instances
      instances/          (+ [slug]/)
      conversations/      (+ [conversationId]/)
      playground/
      activity/
      memory/
  settings/                               → deployment-level, flat
  skills/                                 → deployment-level, flat (until the skills spec)

/platform/*                               → reserved, sibling of the tenant tree (nothing built)
```

Two placements are deliberate and easy to get wrong:

- **The dashboard is org-level, not workspace-level.** It renders
  `api.analytics.global`, which aggregates across every agent in the
  organization. Putting it under a workspace would be the first URL to lie.
- **`/platform/*` is reserved now and built later.** The literal
  `organizations` segment already protects the top level from collisions, so
  reserving the prefix costs nothing and gives the coming Super Admin console
  somewhere to land that is outside the tenant tree.

## 5. Components

### 5.1 Engine — `GET /api/me` (new)

`packages/engine/src/server/me/` — controller + service.

```ts
{
  user: { id, email, name, isPlatformAdmin },
  organization: { slug, name } | null,
  workspaces: [{ slug, name, isDefault }]
}
```

Derived from the principal's `orgId`: resolve the organization row and its
workspaces. Guarded by `@RequirePermission(Permission.ORG_READ)`, which every
system role holds (Viewer included), so no role is locked out of the shell.

`organization: null` is a **valid** response, not an error: it is what a legacy
pre-RBAC JWT (minted before `orgId` existed) produces. The frontend turns it
into an actionable "sign in again" state — re-signing re-mints the token with
`orgId`.

Also needs a `/api/me` entry in the `rewrites()` list of
`packages/web/next.config.ts`, like every other proxied engine route.

### 5.2 Web — `TenantProvider` (in `(admin)/layout.tsx`)

Mounted in the **admin** layout, not in the nested tenant layout. The reason is
the sidebar: it lives in `(admin)/layout.tsx`, above the dynamic segments, and
needs tenant data to build hrefs even on `/settings`, where no tenant params
exist. A provider mounted below the sidebar could not serve it.

Fetches `/api/me` once (module-level promise cache, so nested navigation does
not refetch) and exposes `{ status: "loading" | "ready" | "error", user,
organization, workspaces }`. It **must not** block the whole admin shell:
`/settings` and `/skills` need no tenant data and must keep working when
`/api/me` fails.

### 5.3 Web — `TenantScopeGuard` (in the nested layouts)

Reads the route params, compares them against the provider, calls `notFound()`
on a mismatch, and republishes the active org/workspace for pages to consume.
The comparison itself lives in a pure `validateTenantParams(me, orgSlug,
workspaceSlug?)` so it is unit-testable without React.

### 5.4 Web — `lib/tenant/paths.ts`

`orgPath(org, sub?)`, `workspacePath(org, ws, sub?)`, `PLATFORM_PREFIX`. Pure
functions, no React. This is the only place the URL shape is written down.

### 5.5 Web — navigation

Each `app-sidebar.tsx` item gains `scope: "workspace" | "org" | "deployment"`
and its href is built through the path helpers. The active workspace comes from
`useParams()`, falling back to the `isDefault` workspace from the provider, so
workspace-scope items stay clickable from `/settings`. Workspace-scope items are
disabled while the tenant is unresolved.

`isNavActive` already matches segment-aware with `startsWith`, so longer hrefs
work as-is — **except** the Dashboard item, whose current `url === "/"` special
case disappears once its href is a long path. Without an `exact` flag on that
item it would light up on every sub-route of its own prefix.

### 5.6 Web — `lib/api.ts`

Delete `DEFAULT_ORG_SLUG`; `members.*` takes the org slug from the route; add
`me.get()`. No other API call changes shape — this is what makes the work
FE-only.

## 6. Data flow

Sign-in stamps `orgId` into the JWT → the browser loads `/` → the provider
fetches `/api/me` → the root page redirects to `orgPath(slug)` → the nested
guard validates the params against the already-cached response → pages call
`api.*` exactly as they do today.

## 7. Error handling

| Case | Behaviour |
|---|---|
| `/api/me` fails (network / 5xx) | Error state with retry inside tenant subtrees; children never mount with unvalidated params. Deployment-level pages unaffected. |
| Slug mismatch | `notFound()`. |
| `organization: null` (legacy JWT) | Actionable "sign in again" state — not a 404. |
| 403 on `/api/me` (enforce mode only) | Dedicated error state. |

## 8. Legacy URLs

A shared `<LegacyTenantRedirect sub="…" />` client component plus one-line stub
pages at the old flat locations: the five workspace-level lists (`/instances`,
`/conversations`, `/playground`, `/activity`, `/memory`), `/members`,
`/audit-logs`, and also `/instances/[slug]` and `/conversations/[conversationId]`
— which forward their param, because deep links are the ones people actually
bookmark. The post-login redirect in `auth.config.ts` and the in-code links
across the twelve files that contain them move to the path helpers.

The stubs live for **one release** and are then deleted; that removal gets a
follow-up issue at implementation time, otherwise they stay forever.

## 9. Testing

- **Unit (web):** `paths.ts`; `validateTenantParams`; `isNavActive` with the new
  `exact` flag; scope→href mapping in the sidebar.
- **Component (web):** provider error and legacy-token states; guard mismatch
  calls `notFound()`.
- **Unit (engine):** `/api/me` service — org resolution, `organization: null`,
  workspace list.
- **E2E:** extend `packages/web/e2e/rbac`, which already boots the engine with
  `AUTHZ_ENFORCE=true` — a legacy URL redirects to its canonical form, a bogus
  org slug 404s, a canonical URL renders.
- **i18n:** new keys for every error state, Italian and English.

## 10. Out of scope

- **Workspace-scoped skills.** The catalog (`skills` + `skill_versions`) has no
  workspace or org FK and `/api/skills` receives no tenancy parameter, so this
  needs a migration with backfill, query scoping, **and** a way for the
  workspace to reach the request — which is precisely the API-contract change
  this spec avoids. Own spec.
- **Tenant-scoped API paths** mirroring these frontend paths. Agreed as the
  direct successor to this work; it is what turns the decorative workspace
  segment into a real one.
- `/platform/*` console and Super Admin UI (prefix reserved, nothing built).
- Organization and workspace CRUD, and the switcher — the provider already
  exposes `workspaces[]`, so a switcher is later a UI-only addition.
- The invitation flow (#144) and any default role below Owner.

## 11. Trade-offs

1. **The workspace segment isolates nothing** in this phase (§2). Anyone reading
   these URLs later will assume otherwise.
2. **The landing page flashes a skeleton** for the duration of `/api/me`.
3. **Directory moves use `git mv`** to preserve rename detection. No relative
   import escapes the moved subtrees (everything goes through the `@/` alias),
   so the move itself is mechanical.
