# Upgrading Polyant

This guide covers upgrades that need an operator decision. For the full list of
changes see the [changelog](../CHANGELOG.md).

## Upgrading from 1.1.0 to the next release (unreleased)

This release makes `users.is_platform_admin` the only persisted record of
platform-admin standing and **drops the `users.role` column**. One migration,
one operator decision — but it is the same decision as the 1.1.0 upgrade, for
the same reason.

### 1. This release is NOT a rolling upgrade either — stop, then start

`0075_drop_users_role` reconciles the flag one last time and then drops the
column. Both packages break on an overlapping deploy, and one of them less
obviously than the other:

- An **old engine** replica still calls `listUsers`, `insertUser` and
  `countPlatformAdmins`, all of which name `role` in their SELECT and INSERT
  lists. Every one of them fails with `42703` (undefined column) the moment the
  migration lands — that is the whole users API, not just the platform-admin
  paths.
- An **old web** replica is affected too, which is easy to miss because nothing
  in the panel reads a role any more: its Auth.js Drizzle mirror of the `users`
  table still declares the column, so the adapter selects it on **every** query
  it makes. Credential sign-in fails there, not just the Admin Console.

Deploy with a **stop-then-start** (or single-replica) strategy so exactly one
version of each package serves traffic at a time. Do not use blue/green or a
rolling update with overlap. The condition is transient — it clears as soon as
the last old replica drains — and no data is lost either way.

### 2. There is no rollback past `0075`

The column is gone and `0075` has no down migration. Restoring it means
restoring a backup: an older image would find the column missing and fail on
every read of the users table, and re-adding it by hand would produce an empty
column that no code writes, so every account would read as an ordinary user.

Take a database backup before upgrading. Treat everything from `0071` onward as
forward-only, `0075` included.

### 3. Nobody has to sign in again — but promotions now land on their own

Platform-admin standing is read from the database on every request instead of
being carried on the session token, so promoting or revoking an account takes
effect within the five-minute platform-admin cache window. Where the 1.1.0
upgrade required a sign-out for a membership change, this one does not: no
session rotation is needed, and `AUTH_SECRET` can stay as it is.

### 4. If you automate user creation, move off `role`

`POST /api/users` and `PATCH /api/users/:id` take `isPlatformAdmin: boolean` and
no longer return `role`. `role` is still accepted **on input** for one release,
as a deprecated alias for both legacy spellings (`platform_admin` and
`superadmin`), and is never persisted or echoed back. Any script that reads
`role` off a response is already broken by this release; any script that sends
it has one release to switch.

## Upgrading from 1.0.0 to 1.1.0

This release changes authorization, the persisted platform-admin role value, and
the frontend URL scheme. Read the whole section before starting: two of the steps
have to happen in a specific order, and one of them logs everybody out.

### 0. Audit `POSTGRES_SSL` first — it decides whether the deploy connects at all

`POSTGRES_SSL` used to be parsed with a coercion that treated **every** non-empty
value as true: `POSTGRES_SSL=false` switched TLS **on**, the opposite of what it
says. That is fixed — only the literal `"true"` enables TLS now — and the fix
changes behaviour for anyone who was relying on the old reading, before any
migration runs:

- **`POSTGRES_SSL=false` on managed Postgres (Aurora/RDS/Cloud SQL): the deploy
  fails to connect.** TLS was silently on and is now off; `pg_hba` rejects the
  connection with *"no encryption"*. Set `POSTGRES_SSL=true`.
- **`POSTGRES_SSL=1`, `TRUE`, `require`, `yes`: the engine exits at boot.** The
  value is validated against `true`/`false` now, with no fallback. Rewrite it.

Unset is still the same as `false`. Check every environment — this is the one
change in the release that bites before the migrations even start.

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
24 hours).

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
  remedy. The engine now **refuses to boot** on `alb-oidc` rather than starting a
  panel that 403s on every call — change the variable before you deploy.
- **Member gained `agent.secret:write`** (migration `0072`). Every existing
  Member can now write provider API keys and channel bot tokens, and export an
  agent's full configuration bundle. Secrets stay write-only through the API
  (reads return key names only), but if that is wider than you want, review your
  Member assignments before upgrading — the migration applies to every
  organization with no opt-out, and there is no down migration: narrowing it
  again means editing the role's permissions by hand.

Users created after RBAC first shipped may hold no organization membership at
all (sign-in no longer provisions one). A platform admin grants it with
`PUT /api/organizations/:orgSlug/members/:userId`, or from the Members page.

**After granting it, that user must sign out and back in.** `orgId` is written
into the session token at sign-in and never refreshed, so a membership added (or
moved to a different organization) mid-session is invisible until the token is
replaced — the user keeps getting 403s from a cross-organization scope mismatch,
and reloading the page does not help. Tokens live 24 hours, so the condition
clears on its own within a day, but tell the person to sign out rather than wait.

### 5. Tell users their bookmarks are gone

Frontend URLs are tenant-scoped now, and the legacy flat paths are **not**
redirected: `/instances`, `/conversations/<id>`, `/playground`, `/members` and
friends return a 404 page, as do stale `?tab=` values on the agent detail page.
The canonical form is
`/organizations/<org>/workspaces/<workspace>/…`. Point people at the
organization dashboard and let them re-bookmark.
