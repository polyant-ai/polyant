<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# RBAC E2E tests (Playwright)

End-to-end tests that exercise the RBAC permission boundaries **through the UI**:
real credentials login → real page navigation → assertions on both the engine's
authorization decision (200 vs 403) and the rendered UI.

## What's mocked vs real

- **Real**: PostgreSQL (a dedicated `polyant_e2e` database), the engine
  (NestJS), and the web app (Next.js). Authentication uses the OSS email/password
  credentials provider — no Google OAuth, no cookie forging.
- **Not exercised / inert**: AI providers and channel adapters. The
  members/RBAC flow never calls them, so nothing external is hit (mock by
  omission). Add explicit mocks here only when a future spec needs one.
- **Enforcement is ON**: the engine boots with `AUTHZ_ENFORCE=true`. Without it
  the PermissionGuard runs in shadow mode and every would-be 403 silently
  passes — assertions would be meaningless.

## Prerequisites

```bash
docker compose up -d postgres          # PostgreSQL (pgvector) must be running
npx playwright install chromium        # one-time browser download
npm install                            # picks up @playwright/test + tsx
```

`POSTGRES_PASSWORD` (and any non-default `POSTGRES_*`) is read from the repo-root
`.env` — the same file the dev stack uses. Nothing else to configure.

## Run

```bash
npm run test:e2e -w @polyant/web        # prepare DB, boot engine+web, run specs
npm run test:e2e:ui -w @polyant/web     # interactive UI mode
npm run test:e2e:report -w @polyant/web # open the last HTML report
```

`test:e2e` first runs `e2e/setup/prepare-db.ts` (create DB → migrate → seed),
then Playwright boots the engine on `:4100` and web on `:3100` and runs the
specs. Dedicated ports mean it won't collide with a running dev stack.

## Layout

| Path | Purpose |
|------|---------|
| `setup/test-env.ts` | Single source of truth: ports, URLs, test DB, secrets, seeded users, child-process env. |
| `setup/prepare-db.ts` | Create + migrate + seed the test database (pre-step). |
| `setup/seed-rbac.ts` | Seed the 3 privilege-ladder users (Owner/Member/Viewer). |
| `fixtures/auth.ts` | `loginAs(page, role)` — drives the real /login form. |
| `rbac/members-access.spec.ts` | First DB-integrated test: members-management access per role. |

## Seeded users (default org)

| Role | Email | Members page |
|------|-------|--------------|
| Owner | `owner@e2e.polyant.test` | 200 — can manage |
| Member | `member@e2e.polyant.test` | 403 — denied |
| Viewer | `viewer@e2e.polyant.test` | 403 — denied |

## Known caveat

Running the production build with `NEXT_DIST_DIR=.next-e2e` makes Next rewrite
`next-env.d.ts` to reference `.next-e2e`, dirtying the working tree. Any normal
`next dev` / `next build` rewrites it back to `.next`. If you see it modified
after a run, `git checkout -- packages/web/next-env.d.ts` (or just ignore it).

## Extending

- **Admin role / cross-org isolation**: add an `admin@…` user and a second org
  with its own Owner in `test-env.ts` + `seed-rbac.ts`, then assert cross-org
  requests 403 (the `members.service.ts` choke-point).
- **Per-role storage state**: for speed, log in once per role in a project
  dependency and reuse `storageState` instead of logging in per test.
