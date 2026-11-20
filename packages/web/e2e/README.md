<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# RBAC E2E tests (Playwright)

End-to-end tests that exercise the RBAC permission boundaries **through the UI**:
real credentials login → real page navigation → assertions on both the engine's
authorization decision (200 vs 403) and the rendered UI.

## What's mocked vs real

- **Real**: PostgreSQL (a dedicated `polyant_e2e` database), the engine
  (NestJS), and the web app (Next.js). Authentication uses the OSS email/password
  credentials provider — no Google OAuth, no cookie forging.
- **Faked**: the AI provider. The engine's `openai` provider is pointed at
  `support/fake-model.mjs` (`OPENAI_BASE_URL`), a local server that answers
  the Responses API from a fixed script; only the turn suite gives an agent a
  model that reaches it. No suite can call a real provider.
- **Not exercised / inert**: channel adapters (Telegram, WhatsApp, Slack…).
- **Enforcement is ON, always**: RBAC has no off switch and no shadow mode, so
  the harness sets nothing to enable it and no spec can be silently defanged by
  a missing env var.
- **Rate limiting is OFF**: the suite runs with `THROTTLE_ENABLED=false`, so no
  spec here can assert a 429.

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
npm run test:e2e:panel -w @polyant/web  # only the panel suites (what CI runs on pull requests)
npm run test:e2e:turn -w @polyant/web   # only the turn suite
npm run test:e2e:ui -w @polyant/web     # interactive UI mode
npm run test:e2e:report -w @polyant/web # open the last HTML report
```

`test:e2e` first runs `e2e/setup/prepare-db.ts` (create DB → migrate → seed),
then Playwright boots the engine on `:4100` and web on `:3100` and runs the
specs. Dedicated ports mean it won't collide with a running dev stack. The
fake model listens on the engine port + 1 (`:4101`). Two runs on one machine
keep apart with `E2E_ENGINE_PORT`, `E2E_WEB_PORT`, `E2E_FAKE_MODEL_PORT` and
`E2E_DB_NAME`.

## Layout

| Path | Purpose |
|------|---------|
| `setup/test-env.ts` | Single source of truth: ports, URLs, test DB, secrets, seeded users, child-process env. |
| `setup/prepare-db.ts` | Create + migrate + seed the test database (pre-step). |
| `setup/seed-rbac.ts` | Seed the 3 privilege-ladder users (Owner/Member/Viewer). |
| `fixtures/auth.ts` | `loginAs(page, role)` — drives the real /login form. |
| `rbac/members-access.spec.ts` | First DB-integrated test: members-management access per role. |
| `setup/seed-panel.ts` | Seed the panel user and the showcase agent's history (fixed timestamps). |
| `support/page-catalog.ts` | Every page of the panel, discovered from `src/app` plus one entry per agent section, with the declared redirects. |
| `support/panel.ts` | Browser setup of the panel suites: frozen clock, theme, viewport, `settle()`. |
| `panel/panel.setup.ts` | Signs the panel user in once and saves the session. |
| `panel/catalog.spec.ts` | Keeps the catalog honest: segments filled, redirects landing where declared, pages rendering in place. |
| `a11y/a11y.spec.ts` | axe (WCAG 2.2 A/AA) on every catalog page, light and dark, against `known-violations.json`. |
| `support/fake-model.mjs` | The fake OpenAI model (Responses API, streamed and not); `GET /__calls` lists what it received. |
| `turn/turn.spec.ts` | One real turn with a tool call, from the playground and from `/v1/chat/completions`: shown, stored and listed alike. |
| `rbac/tenant-urls.spec.ts` | Tenant-scoped URL routing: root resolution, canonical render, 404 on foreign slugs (there are no legacy redirects — the tenant-scoped URLs are the only ones). |

## Seeded users (default org)

| Role | Email | Members page |
|------|-------|--------------|
| Owner | `owner@e2e.polyant.test` | 200 — can manage |
| Member | `member@e2e.polyant.test` | 403 — denied |
| Viewer | `viewer@e2e.polyant.test` | 403 — denied |

## Panel suites

The `panel` project visits every page of the panel as `panel@e2e.polyant.test`
(a Platform Admin who owns the default organization), over the data
`seed-panel.ts` writes, with the browser clock stopped at `PANEL_NOW`.

- **A new page** joins on its own. If it has a dynamic segment the catalog has
  no value for, or it redirects, `catalog.spec.ts` fails and says what to add
  to `support/page-catalog.ts`.
- **An accessibility failure** names the rule, the element and the page. Fix
  the page; `known-violations.json` is only for what predates a rule, and an
  entry that no longer matches fails until it is removed, so the list only
  shrinks.
- **More data on a page**: extend `seed-panel.ts`, keeping every timestamp
  before `PANEL_NOW`.

## Turn suite

The `turn` project runs one real turn through the engine and the web. It
creates its own agent (`e2e-turn`, model `openai/gpt-4.1-mini`) through the
panel's API as the panel user, with a provider key, an agent key, `readSkill`
as its only tool and the Web channel on, and deletes it afterwards with its
conversations.

The fake model answers the first step of a turn with a text and a call to
`readSkill`, and the step after the tool's result with a final text. The
suite then checks that:

- the reply the playground streams is the reply stored for the turn, the text
  of the step that called the tool included, and the bubble shows both;
- the tool ran: its result is in the stream, stored with the step, and came
  back to the model;
- the conversation is listed and opens on the stored reply;
- `POST /v1/chat/completions` with the agent's key returns the same reply and
  stores the turn.

The agent keeps every step's text as the reply (`intermediateText: "reply"`).
With no policy set, the playground streams both steps' text while the stored
reply, and the API's answer, hold only the last step's; the suite fails there
by design.

To change what the model says, change the constants at the top of both
`support/fake-model.mjs` and `turn/turn.spec.ts`.

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
