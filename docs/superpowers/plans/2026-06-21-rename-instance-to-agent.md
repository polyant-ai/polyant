# `instance → agent` Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the core domain entity from `instance` to `agent` across the database, engine, and web — staged as independently-deployable PRs — so the term matches the RBAC domain model and both repos converge on `agents` for clean one-way merges.

**Architecture:** Five sequential PRs. The key refinement over the original design (§8) is splitting the **DB-name layer** (PR A1: SQL migration + Drizzle string literals + raw-SQL identifiers) from the **TS-symbol layer** (PR A2: exports, branded types, file names, `resolve*` functions). Drizzle decouples the TS variable name from the DB string it maps to, so each PR leaves the app fully working and individually deployable — no broken intermediate state. The internal filesystem term `workspace` (which collides with the new RBAC `Workspace` domain entity) is renamed to `sandbox` in a separate, independent PR.

**Tech Stack:** PostgreSQL 16 + Drizzle ORM, NestJS 11 (engine), Next.js 16 (web), Vitest, TypeScript ESM.

## Global Constraints

These apply to **every** task below. Copy them into each PR's checklist.

- **Base branch:** all PRs branch from and target `feat/rbac-epic` (NOT `main`/`develop`). The RBAC epic shipped migrations 0050–0052; this rename is **0053**.
- **OSS independence:** the OSS repo MUST contain ZERO references to the enterprise repo, the enterprise package scope, or EE-only concepts. The §8 governance tables (`instance_config_snapshots`, `instance_model_cards`, `instance_compliance_reports`, `governance_policy_assignments`, `governance_events`, and the `assistant_id` column) **DO NOT exist in OSS** — they are EE-only. Do NOT add them to the migration.
- **DCO sign-off:** every commit MUST end with a `Signed-off-by:` trailer. Always use `git commit -s`.
- **Never self-merge:** push feature branches and open PRs; a human merges. Never push to `main`/`develop`.
- **Commit convention:** `type(scope): description` (conventional commits, English). Keep each PR ≤400 LOC of hand-written change where feasible (mechanical rename diffs are exempt from the line cap but must be split by responsibility).
- **`/v1/chat/completions` contract is unchanged:** the `model` field carries the agent **slug**; slug *values* never change (only column names). No breaking change for OpenAI-compat clients.
- **Verification gate for mechanical renames:** because most of this work is mechanical, the "test" for a rename task is: `npm run typecheck` green + full affected test suite green + a **zero-residual grep** proving the old identifier is gone from the renamed surface. Behavioral surfaces (back-compat dual-prefix, web rewrite alias, migration round-trip) get explicit new tests.

---

## Environment Setup (REQUIRED on a fresh clone / remote box)

This plan's verification is **local-only**: the PRs target `feat/rbac-epic`, which is not CI-gated (CI runs only for PRs targeting `main`). So the local gates below are the sole verification — they MUST run, which means a working local env and database.

A fresh clone has **no `.env`** (it is gitignored). Before any task, bootstrap one:

- [ ] **Step 0a: Create `.env` from the example with local docker values**

```bash
cp .env.example .env
# Local postgres (matches docker-compose defaults) + generated secrets:
{
  echo "POSTGRES_HOST=localhost"
  echo "POSTGRES_PORT=5432"
  echo "POSTGRES_DB=polyant"
  echo "POSTGRES_USER=polyant"
  echo "POSTGRES_PASSWORD=polyant"
  echo "DATABASE_URL=postgres://polyant:polyant@localhost:5432/polyant"
  echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
  echo "AUTH_SECRET=$(openssl rand -hex 32)"
  echo "AUTH_INTERNAL_SECRET=$(openssl rand -hex 32)"
} >> .env
```
(Channel/OAuth/S3 secrets stay as `.env.example` placeholders — the rename touches none of them.)

- [ ] **Step 0b: Bring up postgres + install + migrate to current head**

```bash
docker compose up -d                 # pgvector/pgvector:pg16 on :5432
until docker compose exec -T postgres pg_isready -U polyant -d polyant; do sleep 2; done
npm install
npm run db:migrate -w @polyant/engine   # applies 0001…0052 onto the fresh DB
```

Only after this baseline is green do the track tasks (which add migration 0053 etc.) make sense. If `docker compose` is unavailable, STOP and report — the DB gates cannot be skipped.

---

## Ground-Truth Inventory (verified against the codebase 2026-06-21)

The original design §8 predates hooks (0046–48), GDPR opt-out (0049) and RBAC (0050–52), so its table list is **stale**. This is the authoritative OSS list.

**Tables to rename (table name + `instance_id` → `agent_id` column):**

| Current table | New table |
|---|---|
| `instances` | `agents` |
| `instance_prompts` | `agent_prompts` |
| `instance_skills` | `agent_skills` |
| `instance_tools` | `agent_tools` |
| `instance_secrets` | `agent_secrets` |
| `instance_channels` | `agent_channels` |
| `instance_skill_env` | `agent_skill_env` |
| `instance_room` | `agent_room` |
| `instance_hooks` | `agent_hooks` |

**Tables that keep their name but rename the `instance_id` column → `agent_id`** (text-slug or FK columns; slug *values* unchanged):

`conversations`, `memories`, `pipeline_traces`, `tool_audit_logs`, `ai_logs`, `knowledge_documents`, `knowledge_chunks`, `scheduled_tasks`, `scheduled_task_runs`, `event_sources`, `event_backlog`, `room_activity_log`, `contact_optouts`, `hook_executions`.

> ⚠️ Verify each column actually exists at execution time with the discovery step in Task A1.0 — do not trust this table blindly; schema may have drifted.

**Engine surface (real counts, 2026-06-21):**
- `resolveInstanceId`: **79 occurrences across 28 files**
- Branded identifiers `InstanceSlug`/`InstanceUuid`: **122 files**
- Controllers with `api/instances` prefix: **16**
- RBAC-specific DB-name refs (must move in A1): `authz/scope-filter.ts` (raw SQL `from instances i`, column allowlist `instance_id`/`c.instance_id`/`al.instance_id`), `authz/authz.store.ts` (`readAgentScope` joins `instances`), `authz/cross-org-isolation.integration.test.ts` (raw `INSERT/DELETE … instances`).

**Web surface:** `/api/instances/` — **74 occurrences across 4 files**; route group `packages/web/src/app/(admin)/instances/`.

**Internal `workspace` collision:** 46 `WORKSPACES_ROOT` refs + `packages/engine/src/workspace/` dir vs. the new RBAC `workspaces` table (0050).

---

## PR Sequence Overview

| PR | Track | Deliverable | Depends on |
|---|---|---|---|
| **PR-0** | Internal sandbox rename | `workspace`→`sandbox` for the filesystem sandbox term | none (independent) |
| **PR-1** | A1 — DB layer | Migration 0053 + Drizzle string literals + raw-SQL identifiers | none |
| **PR-2** | A2 — Engine symbols | TS exports, branded types, `resolve*`, files, dual-prefix controllers | PR-1 |
| **PR-3** | A3 — Web | `/api/agents/` call sites, route group, rewrite alias | PR-2 |
| **PR-4** | A4 — Alias removal | Drop dual prefix + deprecated rewrite | PR-3 stabilized |

PR-0 and PR-1 are independent and may proceed in parallel. PR-2→PR-3→PR-4 are strictly ordered.

---

## PR-0 — Internal `workspace` → `sandbox` rename

**Why first/parallel:** independent of the domain rename, and it removes the term collision before "Workspace" (RBAC) gains UI presence. Small, self-contained.

**Files:**
- Rename dir: `packages/engine/src/workspace/` → `packages/engine/src/sandbox/`
- Modify: `packages/engine/src/config.ts` (env var `WORKSPACES_ROOT` → `SANDBOX_ROOT`; keep reading `WORKSPACES_ROOT` as a deprecated fallback for one release)
- Modify: all 46 `WORKSPACES_ROOT` ref sites + the `workspaces/<id>/conversations/...` path builder
- Modify: `.env`, `.env.example`, `docker-compose.yml`, `CLAUDE.md` (path doc), `.gitignore` (`workspaces/` entry)
- Test: `packages/engine/src/sandbox/*.test.ts` (moved)

**Interfaces:**
- Produces: env `SANDBOX_ROOT` (default unchanged path value), sandbox resolver functions under the new module path. No DB or API change.

- [ ] **Step 1: Discovery — confirm the full ref set**

```bash
grep -rn 'WORKSPACES_ROOT' packages/engine/src .env .env.example docker-compose.yml
grep -rn "workspace/" packages/engine/src --include='*.ts' | grep -i sandbox
git mv packages/engine/src/workspace packages/engine/src/sandbox
```

- [ ] **Step 2: Add the env alias in config.ts (back-compat)**

In `packages/engine/src/config.ts`, accept the new var with a fallback so existing deployments don't break:

```ts
// CONVENTION-EXCEPTION: dual env read during sandbox rename deprecation window
SANDBOX_ROOT: z.string().optional(),
WORKSPACES_ROOT: z.string().optional(), // deprecated alias, remove next release
```

And where the value is consumed, prefer `SANDBOX_ROOT ?? WORKSPACES_ROOT`.

- [ ] **Step 3: Update all import paths and identifiers**

Update the 46 ref sites (`WORKSPACES_ROOT` → `SANDBOX_ROOT`, `.../workspace/...` imports → `.../sandbox/...`). Update `.env`, `.env.example`, `docker-compose.yml`, `.gitignore`, and the `CLAUDE.md` directory-structure note.

- [ ] **Step 4: Run typecheck + sandbox tests**

```bash
npm run typecheck -w @polyant/engine
npm test -w @polyant/engine -- src/sandbox
```
Expected: PASS.

- [ ] **Step 5: Zero-residual check**

```bash
grep -rn 'WORKSPACES_ROOT' packages/engine/src   # expect only the deprecated-alias line in config.ts
grep -rn 'src/workspace' packages/engine/src     # expect 0
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -s -m "refactor(engine): rename internal workspace sandbox term to sandbox

Frees the 'Workspace' name for the RBAC domain entity. SANDBOX_ROOT
replaces WORKSPACES_ROOT (old var kept as a deprecated fallback)."
```

---

## PR-1 — Track A1: DB layer (migration 0053 + Drizzle strings + raw SQL)

**Why this split:** the migration renames DB tables/columns. Anything that names a DB string directly — Drizzle `pgTable("instances", …)` / `uuid("instance_id")` literals AND raw SQL (`from instances i`) — must change in the *same* PR or the app breaks. TS *symbols* (the `instances` export, `instanceId` property) are deliberately left unchanged here; they move in PR-2. This keeps the app working after PR-1 alone.

**Files:**
- Create: `packages/engine/src/database/migrations/0053_rename_instance_to_agent.sql`
- Modify (Drizzle string literals only): `packages/engine/src/instances/schema.ts`, `prompts.schema.ts`, `instance-skills.schema.ts`, `instance-tools.schema.ts`, `secrets.schema.ts`, `channels.schema.ts`, `skill-env.schema.ts`, `packages/engine/src/room/room.schema.ts`, `hooks/hooks.schema.ts`, `conversations/schema.ts`, `memory/schema.ts`, `analytics/traces.schema.ts`, `audit/audit.schema.ts`, `ai-gateway/logger.ts`, `knowledge/schema.ts`, `scheduled-tasks/schema.ts`, `optout/optout.schema.ts`, `webhooks/webhooks.schema.ts`
- Modify (raw SQL DB-name refs): `packages/engine/src/authz/scope-filter.ts`, `authz/authz.store.ts`, `utils/query-helpers.ts`
- Test: `packages/engine/src/database/0053-rename.integration.test.ts` (new), plus existing `authz/scope-filter.test.ts`, `authz/cross-org-isolation.integration.test.ts`, `organizations/rbac-migration.integration.test.ts`

**Interfaces:**
- Produces: DB tables `agents` + `agent_*`, column `agent_id` everywhere. Drizzle still **exports** `instances`/`instanceId` symbols (mapping strings updated underneath) — PR-2 consumes and renames those symbols.

- [ ] **Step 1: Discovery — verify the exact table/column set against the live DB**

```bash
docker exec polyant-postgres psql -U postgres -d polyant -c "\dt" | grep -iE 'instance'
docker exec polyant-postgres psql -U postgres -d polyant -c \
  "SELECT table_name FROM information_schema.columns WHERE column_name='instance_id' ORDER BY 1;"
```
Reconcile the output against the Ground-Truth Inventory table. Add/remove rows in the migration to match reality. **Do not include any governance/`assistant_id` table** (EE-only).

- [ ] **Step 2: Write the migration round-trip test (failing)**

Create `packages/engine/src/database/0053-rename.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { queryClient } from "../database/client.js";

describe("0053 instance→agent rename", () => {
  it("renames the agents table and removes the instances table", async () => {
    const rows = await queryClient`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('agents','instances')`;
    const names = rows.map((r) => r.table_name);
    expect(names).toContain("agents");
    expect(names).not.toContain("instances");
  });

  it("renames instance_id to agent_id on tenant-scoped tables", async () => {
    const rows = await queryClient`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='conversations' AND column_name IN ('instance_id','agent_id')`;
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain("agent_id");
    expect(cols).not.toContain("instance_id");
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
npm test -w @polyant/engine -- src/database/0053-rename.integration.test.ts
```
Expected: FAIL (table is still `instances`, column still `instance_id`).

- [ ] **Step 4: Write migration `0053_rename_instance_to_agent.sql`**

Single transaction (full rollback on any failure). Adjust the list to match Step 1's discovery output. Governance block from §8 is **omitted** (EE-only).

```sql
BEGIN;

-- Main table
ALTER TABLE instances RENAME TO agents;

-- Child tables with UUID FK (rename table + column)
ALTER TABLE instance_prompts   RENAME TO agent_prompts;
ALTER TABLE agent_prompts      RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_skills    RENAME TO agent_skills;
ALTER TABLE agent_skills       RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_tools     RENAME TO agent_tools;
ALTER TABLE agent_tools        RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_secrets   RENAME TO agent_secrets;
ALTER TABLE agent_secrets      RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_channels  RENAME TO agent_channels;
ALTER TABLE agent_channels     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_skill_env RENAME TO agent_skill_env;
ALTER TABLE agent_skill_env    RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_room      RENAME TO agent_room;
ALTER TABLE agent_room         RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_hooks     RENAME TO agent_hooks;
ALTER TABLE agent_hooks        RENAME COLUMN instance_id TO agent_id;

-- Tables keeping their name, column rename only (slug values unchanged)
ALTER TABLE conversations       RENAME COLUMN instance_id TO agent_id;
ALTER TABLE memories            RENAME COLUMN instance_id TO agent_id;
ALTER TABLE pipeline_traces     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE tool_audit_logs     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE ai_logs             RENAME COLUMN instance_id TO agent_id;
ALTER TABLE knowledge_documents RENAME COLUMN instance_id TO agent_id;
ALTER TABLE knowledge_chunks    RENAME COLUMN instance_id TO agent_id;
ALTER TABLE scheduled_tasks     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE scheduled_task_runs RENAME COLUMN instance_id TO agent_id;
ALTER TABLE event_sources       RENAME COLUMN instance_id TO agent_id;
ALTER TABLE event_backlog       RENAME COLUMN instance_id TO agent_id;
ALTER TABLE room_activity_log   RENAME COLUMN instance_id TO agent_id;
ALTER TABLE contact_optouts     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE hook_executions     RENAME COLUMN instance_id TO agent_id;

COMMIT;
```

> Note: Postgres auto-renames the PK/FK constraints and indexes that reference the table, but **named** indexes/constraints keep their old name string. If Step 1 reveals indexes like `instance_prompts_instance_id_idx`, add `ALTER INDEX … RENAME TO …` lines for cosmetic consistency (optional; not functionally required).

- [ ] **Step 5: Apply the migration and re-run the round-trip test**

```bash
npm run db:migrate -w @polyant/engine
npm test -w @polyant/engine -- src/database/0053-rename.integration.test.ts
```
Expected: PASS.

- [ ] **Step 6: Update Drizzle string literals (table + column names ONLY)**

In every schema file, change the DB-name strings while **keeping the TS export/property names**. Example (`instances/schema.ts`):

```ts
// before
export const instances = pgTable("instances", { /* … */ });
// after — TS symbol still `instances`, DB string now "agents"
export const instances = pgTable("agents", { /* … */ });
```

And every child column literal: `uuid("instance_id")` → `uuid("agent_id")` (the TS property `instanceId` stays). Repeat across all schema files listed in **Files**.

- [ ] **Step 7: Update raw-SQL DB-name references**

`authz/scope-filter.ts`: `from instances i` → `from agents i`; column allowlist `["instance_id","c.instance_id","al.instance_id"]` → `["agent_id","c.agent_id","al.agent_id"]` and the default param `"instance_id"` → `"agent_id"`. Update the doc comment.
`authz/authz.store.ts`: the `readAgentScope` join still uses the Drizzle `instances` symbol — no raw SQL there, so it follows Step 6 automatically; verify it compiles.
`authz/cross-org-isolation.integration.test.ts`: raw `INSERT INTO instances (… instance_id …)` / `DELETE FROM instances` → `agents` / `agent_id`.
`utils/query-helpers.ts`: update any hardcoded `instance_id` SQL fragment to `agent_id`.

- [ ] **Step 8: Full engine suite + typecheck**

```bash
npm run typecheck -w @polyant/engine
npm test -w @polyant/engine
```
Expected: PASS (2029+ tests). Investigate any failure as REGRESSION vs TEST-OUTDATED per `.claude/rules/testing.md`.

- [ ] **Step 9: Zero-residual check (DB-name strings only)**

```bash
# No Drizzle literal or raw SQL should still name the old DB identifiers:
grep -rn '"instance_id"' packages/engine/src --include='*.ts' | grep -vE '\.test\.ts'   # expect 0 in schema files
grep -rni 'from instances\b\|into instances\b\|table instances\b' packages/engine/src   # expect 0
grep -rn 'pgTable("instance' packages/engine/src                                        # expect 0
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -s -m "feat(db): migration 0053 rename instances→agents (table+column layer)

Renames 9 instance_* tables to agent_* and the instance_id column to
agent_id across 14 tenant-scoped tables, in one transaction. Updates
Drizzle table/column string literals and raw-SQL identifiers to match.
TS symbols (instances export, instanceId, resolveInstanceId) unchanged —
renamed in the follow-up engine PR. /v1 slug contract unchanged."
```

---

## PR-2 — Track A2: Engine TS symbols

**Why a separate PR:** pure TypeScript identifier rename — no DB or wire change. Large (122 files touch the branded types) but mechanical and verifiable by typecheck + the existing suite.

**Order (minimizes in-progress compile errors):**

1. `instances/identifiers.ts`: `InstanceSlug`→`AgentSlug`, `InstanceUuid`→`AgentUuid`, `asInstanceSlug`→`asAgentSlug`, `asInstanceUuid`→`asAgentUuid`.
2. `instances/schema.ts`: export `instances`→`agents`, type `Instance`→`Agent`, property `instanceId`→`agentId`; child schemas likewise.
3. `instances/resolve-instance-id.ts` → `instances/resolve-agent-id.ts`: `resolveInstanceId`→`resolveAgentId`, `resolveInstanceSlug`→`resolveAgentSlug`.
4. Stores/services of the renamed tables (function/var names, params).
5. Controllers: dual prefix `@Controller(["api/agents", "api/instances"])` — back-compat.
6. `instances/defaults.ts` → `agents/defaults.ts`; finally consider moving the whole `instances/` module under `agents/`.

> ⚠️ **Directory-collision caveat:** `packages/engine/src/agents/` ALREADY exists (the AI-agent framework: `supervisor/`, `tools/`). Moving the `instances/` module wholesale to `agents/` would merge into it. **Decision for the executor:** keep the renamed module at `packages/engine/src/agents/config/` (or leave files in place and rename only symbols) rather than dumping config schema next to `supervisor/`. Confirm the chosen target path before `git mv`. File moves are the riskiest part — do them last, after symbol renames are green, in their own commit.

**Files:** ~122 files referencing branded identifiers; 28 files with `resolveInstanceId`; 16 controllers. Plus the renamed files in steps 1–3 and 6.

**Interfaces:**
- Consumes: DB schema from PR-1 (tables `agents`/`agent_*`, column `agent_id`).
- Produces: `resolveAgentId(slug: AgentSlug): Promise<AgentUuid | undefined>`, `resolveAgentSlug(id: AgentUuid): Promise<AgentSlug | undefined>`, exported `agents` table + `Agent` type, branded `AgentSlug`/`AgentUuid`, `asAgentSlug`/`asAgentUuid`. Controllers answer on BOTH `api/agents/*` and `api/instances/*`.

- [ ] **Step 1: Rename branded identifiers (`identifiers.ts`) + run typecheck to surface the blast radius**

Edit `instances/identifiers.ts` first. `npm run typecheck -w @polyant/engine` will now light up every consuming file — that list IS your worklist.

- [ ] **Step 2: Mechanically rename symbols across the engine**

Work module-by-module in the order above. Per `.claude/rules/typescript-style.md`: named exports only, `.js` import extensions, kebab-case filenames. Rename files with `git mv` (preserve history): `resolve-instance-id.ts`→`resolve-agent-id.ts`, `resolve-instance-id.test.ts`→`resolve-agent-id.test.ts`.

- [ ] **Step 3: Add the dual-prefix controllers + a back-compat test (failing first)**

Change each of the 16 controllers from `@Controller("api/instances/...")` to `@Controller(["api/agents/...", "api/instances/..."])`. Write a back-compat test asserting both prefixes resolve, e.g. in `packages/engine/src/server/instances/instances.controller.test.ts`:

```ts
it("serves the agents list on both /api/agents and /api/instances", async () => {
  const viaAgents = await request(app.getHttpServer()).get("/api/agents").set(authHeader);
  const viaInstances = await request(app.getHttpServer()).get("/api/instances").set(authHeader);
  expect(viaAgents.status).toBe(200);
  expect(viaInstances.status).toBe(200);
  expect(viaAgents.body).toEqual(viaInstances.body);
});
```
Run it (FAIL → wire dual prefix → PASS).

- [ ] **Step 4: Full engine suite + typecheck + lint**

```bash
npm run typecheck -w @polyant/engine
npm test -w @polyant/engine
npm run lint -w @polyant/engine
```
Expected: all PASS. The custom ESLint rule `polyant/require-inject-in-nest-classes` must stay green (don't drop `@Inject(...)` during renames).

- [ ] **Step 5: Zero-residual check (TS symbols)**

```bash
grep -rn 'resolveInstanceId\|resolveInstanceSlug' packages/engine/src        # expect 0
grep -rn 'InstanceSlug\|InstanceUuid\|asInstanceSlug\|asInstanceUuid' packages/engine/src  # expect 0
grep -rn '\binstanceId\b' packages/engine/src --include='*.ts' | grep -v '\.test\.' # review residual; should be ~0 in non-test
```

- [ ] **Step 6: Commit (split: symbols, then file moves)**

```bash
git add -A
git commit -s -m "refactor(engine): rename instance symbols to agent (types, stores, resolvers)"
# separate commit for the risky file/dir moves:
git commit -s -m "refactor(engine): move instance config module under agents, dual-prefix controllers"
```

---

## PR-3 — Track A3: Web

**Files:**
- Modify: `packages/web/src/lib/api.ts` (74 `/api/instances/` call sites across 4 files → `/api/agents/`)
- Rename: `packages/web/src/app/(admin)/instances/` → `packages/web/src/app/(admin)/agents/` (route group + nested `[slug]` pages)
- Modify: `packages/web/next.config.ts` (add `/api/agents/:path*` rewrite; keep `/api/instances/:path*` as a deprecated alias)
- Modify: sidebar/nav links, i18n keys referencing `instances`
- Test: web component/route tests touching these paths

**Interfaces:**
- Consumes: engine `api/agents/*` endpoints (live since PR-2; `api/instances/*` still works as fallback).
- Produces: web calls `/api/agents/*`; UI route is `/agents/[slug]`.

- [ ] **Step 1: Update `next.config.ts` rewrites (add agents, keep instances alias)**

```ts
async rewrites() {
  return [
    { source: "/api/agents/:path*", destination: `${ENGINE_URL}/api/agents/:path*` },
    // deprecated alias — remove in alias-removal PR (PR-4)
    { source: "/api/instances/:path*", destination: `${ENGINE_URL}/api/instances/:path*` },
    // …existing rewrites
  ];
}
```

- [ ] **Step 2: Rewrite the 74 `/api/instances/` call sites → `/api/agents/`**

```bash
grep -rln '/api/instances' packages/web/src
# edit each (api.ts is the bulk); replace the path prefix only
```

- [ ] **Step 3: Move the route group + fix imports/links**

```bash
git mv "packages/web/src/app/(admin)/instances" "packages/web/src/app/(admin)/agents"
grep -rn '/instances' packages/web/src --include='*.tsx' --include='*.ts'  # fix nav links, redirects, i18n
```

- [ ] **Step 4: Typecheck + build + web tests**

```bash
npm run typecheck -w @polyant/web
npm test -w @polyant/web
npm run build:web
```
Expected: PASS (383+ web tests; build clean).

- [ ] **Step 5: Zero-residual check**

```bash
grep -rn '/api/instances' packages/web/src   # expect 0 (the alias lives only in next.config.ts)
grep -rn '(admin)/instances' packages/web/src # expect 0
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -s -m "refactor(web): route admin UI through /api/agents and /agents/[slug]

Keeps /api/instances rewrite as a deprecated alias for one release."
```

---

## PR-4 — Track A4: Alias removal (after stabilization)

**Precondition:** PR-1…PR-3 merged and stable; no client is calling the deprecated `/api/instances/*` paths (verify via access logs / a deprecation period).

**Files:**
- Modify: the 16 engine controllers — `@Controller(["api/agents", "api/instances"])` → `@Controller("api/agents")`
- Modify: `packages/web/next.config.ts` — remove the `/api/instances/:path*` rewrite
- Modify: config.ts — remove the `WORKSPACES_ROOT` deprecated env fallback (from PR-0), if its deprecation window has elapsed

- [ ] **Step 1: Drop the dual prefix from controllers**

Remove the `"api/instances"` element from every `@Controller([...])` array. Delete the back-compat test from PR-2 Step 3 (or flip it to assert `/api/instances` now 404s).

- [ ] **Step 2: Remove the deprecated web rewrite**

Delete the `/api/instances/:path*` rewrite block from `next.config.ts`.

- [ ] **Step 3: Verify + commit**

```bash
npm run typecheck && npm test && npm run lint
git commit -s -m "chore: remove deprecated api/instances alias and rewrite"
```

---

## Self-Review

**Spec coverage:** A1 (migration) ✓ PR-1; A2 (engine) ✓ PR-2; A3 (web) ✓ PR-3; A4 (alias removal) ✓ PR-4; internal `workspace`→`sandbox` ✓ PR-0. RBAC-specific nuance (scope-filter, authz.store, workspace_id, migration 0053 numbering) ✓ called out in A1 + Inventory.

**Deviations from §8 (deliberate, documented):**
1. Migration is **0053**, not 0030 (§8 predates RBAC migrations).
2. **Governance block dropped** — those tables are EE-only, absent from OSS.
3. **Hooks/optout tables added** — §8 predates 0046–0049.
4. **A1 split into DB-strings vs A2 TS-symbols** so each PR is independently deployable (§8 implied a breakable intermediate state).
5. **Directory-collision caveat** for `agents/` (already exists as the AI-agent framework) — §8 assumed a clean `instances/→agents/` move.

**Placeholder scan:** migration SQL is complete; test code is concrete; rename mappings are explicit. Mechanical per-file diffs are represented by exact old→new symbol mappings + verification gates (appropriate for a 122-file rename — enumerating every file diff is neither feasible nor useful).

**Type consistency:** `resolveAgentId`/`resolveAgentSlug`, `AgentSlug`/`AgentUuid`, `asAgentSlug`/`asAgentUuid`, `agents`/`Agent`, `agent_id` — used consistently across PR-2 and PR-3 interface blocks.
