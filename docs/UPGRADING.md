# Upgrading Polyant

This guide covers upgrades that need an operator decision. For the full list of
changes see the [changelog](../CHANGELOG.md).

## Upgrading from 1.0.0

This release changes authorization, the persisted platform-admin role value, and
the frontend URL scheme. Read the whole section before starting: two of the steps
have to happen in a specific order, and one of them logs everybody out.

### 1. This release is NOT a rolling upgrade — stop, then start

The engine applies migrations at container start (`docker-entrypoint.sh` runs
`migrate.js` and then boots), so migration and code are atomic **per container**
but not across replicas. Two migrations in this release make an overlapping
deploy unsafe:

- **`0071_platform_admin_role_value`** rewrites `users.role` from `superadmin` to
  `platform_admin`. The code that accepts both spellings ships in this release,
  so new code reads old and new data correctly — but an **old** replica still
  running alongside knows only `superadmin`, and it classifies every platform
  admin as an ordinary user. While both versions serve traffic, platform admins
  get intermittent 403s depending on which replica answers.
- **`0073_instance_mcp_servers`** and **`0074_add_a2a_enabled`** add columns the
  new code reads unconditionally. Starting the new code *before* the migration
  fails every agent read with `42703` (undefined column).

Deploy with a **stop-then-start** (or single-replica) strategy so exactly one
version serves traffic at a time. Do not use blue/green or a rolling update with
overlap. The condition is transient — it clears as soon as the last old replica
drains — and no data is lost either way.

### 2. There is no rollback past `0071`

`0071` has no down migration, and rolling back is worse than a failed forward
deploy: the 1.0.0 image compares `role === "superadmin"`, so after the value has
been rewritten nobody can reach `/api/users`, while `is_platform_admin` stays
`true` and keeps granting the permission-guard bypass — a half-privileged state.

If you must roll back, restore the role value first:

```sql
UPDATE users SET role = 'superadmin', updated_at = now() WHERE role = 'platform_admin';
```

Take a database backup before upgrading. Treat everything from `0071` onward as
forward-only.

### 3. Force every user to sign in again

`orgId` is stamped into the session JWT **at sign-in only**. Anyone signed in
across the upgrade keeps a token without that claim and is denied on every
organization-scoped management route for the remaining life of the token (up to
30 days).

Rotate `AUTH_SECRET` as part of the deploy (or clear the `sessions` table). Every
user gets a login prompt once and a correct token thereafter. This is not
optional — without it the panel appears broken for already-signed-in users.

### 4. Check who can reach what, before you announce the upgrade

Three authorization changes take effect immediately:

- **RBAC is enforced unconditionally.** `AUTHZ_ENFORCE` no longer exists; remove
  it from your environment. If your install previously copied the sample `.env`
  with `AUTHZ_ENFORCE=false`, every permission check was a no-op until now —
  expect denials that were previously silent passes, and verify each role can
  still do its job.
- **`AUTH_MODE=alb-oidc` deployments must switch to `AUTH_MODE=session`.** A
  gateway-forwarded identity carries no organization and holds no role bindings,
  so under enforced RBAC it is denied on every management route with no runtime
  remedy.
- **Member gained `agent.secret:write`** (migration `0072`). Every existing
  Member can now write provider API keys and channel bot tokens, and export an
  agent's full configuration bundle. Secrets stay write-only through the API
  (reads return key names only), but if that is wider than you want, review your
  Member assignments before upgrading — the migration applies to every
  organization with no opt-out.

Users created after RBAC first shipped may hold no organization membership at
all (sign-in no longer provisions one). A platform admin grants it with
`PUT /api/organizations/:orgSlug/members/:userId`, or from the Members page.

### 5. Tell users their bookmarks are gone

Frontend URLs are tenant-scoped now, and the legacy flat paths are **not**
redirected: `/instances`, `/conversations/<id>`, `/playground`, `/members` and
friends return a 404 page, as do stale `?tab=` values on the agent detail page.
The canonical form is
`/organizations/<org>/workspaces/<workspace>/…`. Point people at the
organization dashboard and let them re-bookmark.
