# `instance → agent` Rename Implementation Plan (develop rebase)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the core domain entity from `instance` to `agent` across the database, engine, and web, so the term matches the RBAC domain model and both repos converge on `agents` for clean one-way merges.

**Status:** This supersedes `2026-06-21-rename-instance-to-agent.md`, which targeted the `feat/rbac-epic` base and migration slot 0053. That plan was executed on `feat/rename-instance-to-agent` (PR #125); the branch went stale (494 commits behind `develop`, 372 conflicting files) and is being redone on `develop` rather than merged. The tracks, ordering and verification gates are unchanged — only the base, the migration number and the table inventory are.

**Architecture:** Five sequential tracks. The key refinement is splitting the **DB-name layer** (PR-1: SQL migration + Drizzle string literals + raw-SQL identifiers) from the **TS-symbol layer** (PR-2: exports, branded types, file names, `resolve*` functions). Drizzle decouples the TS variable name from the DB string it maps to, so each track leaves the app fully working — no broken intermediate state. The internal filesystem term `workspace` (which collides with the RBAC `Workspace` entity) is renamed to `sandbox` in an independent track.

**Tech Stack:** PostgreSQL 16 + Drizzle ORM, NestJS 11 (engine), Next.js 16 (web), Vitest, TypeScript ESM.

## Deltas vs the 2026-06-21 plan

Everything below was re-verified against `develop` on 2026-08-06. Do not trust the older plan's numbers.

| | 2026-06-21 plan | This plan |
|---|---|---|
| Base branch | `feat/rbac-epic` | `develop` |
| Migration slot | 0053 | **0073** (head is 0072) |
| CI | not gated | `develop` **is** CI-gated |
| Tables with `instance_id` | 14 + 9 renamed | **17 + 9 renamed** — adds `conversation_state` (0043), `principal_secrets` (0069), `oauth_states` (0070) |
| Branded-id files | 122 | **126** |
| `resolveInstanceId` refs | 79 | **94** |
| Controllers on `api/instances` | 16 | **15** |
| Web `/api/instances` refs | 74 across 4 files | **78 across 6 files** |
| `WORKSPACES_ROOT` refs | 46 | **47** |

**Incoming collision — `instance_mcp_servers`:** the MCP-client branch (PR #237) adds this table and it is already present in the local dev database, but it is **not** in `develop`. It is deliberately **excluded** from migration 0073. Whichever of the two lands second must rename the other's surface: if MCP merges first, add `instance_mcp_servers → agent_mcp_servers` to 0073; if this lands first, MCP must be authored as `agent_mcp_servers` and renumbered.

## Global Constraints

These apply to **every** track below.

- **Base branch:** `develop` (gitflow — never `main`). Branch: `feat/rename-agent-domain`.
- **OSS independence:** the OSS repo MUST contain ZERO references to the enterprise repo or EE-only concepts. The governance tables (`instance_config_snapshots`, `instance_model_cards`, `instance_compliance_reports`, `governance_*`, the `assistant_id` column) **DO NOT exist in OSS** — do NOT add them to the migration.
- **DCO sign-off:** every commit MUST end with a `Signed-off-by:` trailer. Always use `git commit -s`.
- **Never self-merge:** push the branch and open a PR; a human merges.
- **Commit convention:** `type(scope): description` (conventional commits, English). Mechanical rename diffs are exempt from the 400-LOC cap but must be split by responsibility — one commit per track.
- **`/v1/chat/completions` contract is unchanged:** the `model` field carries the agent **slug**; slug *values* never change (only column names). No breaking change for OpenAI-compat clients.
- **Verification gate for mechanical renames:** `npm run typecheck` green + the affected suite green + a **zero-residual grep** proving the old identifier is gone from the renamed surface. Behavioral surfaces (dual-prefix back-compat, web rewrite alias, migration round-trip) get explicit new tests.
- **Baseline first:** record the `develop` typecheck/test result BEFORE the first edit. Any failure present in the baseline is not a regression of this work (see `.claude/rules/testing.md` for the classification taxonomy).

## Ground-Truth Inventory (verified against `develop` + the live DB, 2026-08-06)

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

`conversations`, `conversation_state`, `memories`, `pipeline_traces`, `tool_audit_logs`, `ai_logs`, `knowledge_documents`, `knowledge_chunks`, `scheduled_tasks`, `scheduled_task_runs`, `event_sources`, `event_backlog`, `room_activity_log`, `contact_optouts`, `hook_executions`, `principal_secrets`, `oauth_states`.

> ⚠️ Re-run the Task PR-1 Step 1 discovery against the live DB before writing the migration — the schema may have drifted again, and the local DB may carry tables from unmerged branches (see the `instance_mcp_servers` note above).

**Engine surface:** `resolveInstanceId`/`resolveInstanceSlug` 94 refs; branded `InstanceSlug`/`InstanceUuid` 126 files; 15 controllers on the `api/instances` prefix (`instances.controller`, `instance-export`, `instance-skills`, `instance-secrets`, `instance-prompts`, `instance-scheduled-tasks`, `instance-channels`, `instance-knowledge`, `instance-tools`, `instance-hooks`, `room`, `optouts`, …). Raw-SQL DB-name refs to move in PR-1: `authz/scope-filter.ts` (`from instances i`, column allowlist), `utils/query-helpers.ts`, `authz/cross-org-isolation.integration.test.ts`.

**Web surface:** `/api/instances` — 78 occurrences across `lib/api.ts`, `lib/api-types.ts`, `lib/api.test.ts`, `lib/utils.ts`, the playground `stream-parser.ts` and the agent `settings-tab.tsx`; route group `packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/instances/`.

**Internal `workspace` collision:** 47 `WORKSPACES_ROOT` refs + `packages/engine/src/workspace/` dir vs. the RBAC `workspaces` table.

## Track Sequence Overview

| Track | Deliverable | Depends on |
|---|---|---|
| **PR-0** | `workspace`→`sandbox` for the filesystem sandbox term | none |
| **PR-1** | Migration 0073 + Drizzle string literals + raw-SQL identifiers | none |
| **PR-2** | Engine TS symbols, branded types, `resolve*`, dual-prefix controllers | PR-1 |
| **PR-3** | Web `/api/agents` call sites, route group, rewrite alias | PR-2 |
| **PR-4** | Drop the dual prefix + deprecated rewrite | PR-3 |

PR-0 and PR-1 are independent. PR-2→PR-3→PR-4 are strictly ordered. All five land as separate commits on one branch: #125 rotted from sitting six weeks, not from being a single PR, and splitting into five human-merge round-trips would re-create exactly that staleness risk.

---

## PR-0 — Internal `workspace` → `sandbox` rename

**Why first:** independent of the domain rename, and it removes the term collision before "Workspace" (RBAC) gains more UI presence.

**Files:** rename dir `packages/engine/src/workspace/` → `packages/engine/src/sandbox/`; `config.ts` (env `WORKSPACES_ROOT` → `SANDBOX_ROOT`, old var kept as a deprecated fallback); the 47 ref sites + the `workspaces/<id>/conversations/...` path builder; `.env.example`, `docker-compose.yml`, `CLAUDE.md`, `.gitignore`.

- [ ] **Step 1: Discovery — confirm the full ref set**

```bash
grep -rn 'WORKSPACES_ROOT' packages/engine/src .env.example docker-compose.yml
git mv packages/engine/src/workspace packages/engine/src/sandbox
```

- [ ] **Step 2: Add the env alias in `config.ts` (back-compat)**

```ts
// CONVENTION-EXCEPTION: dual env read during sandbox rename deprecation window
SANDBOX_ROOT: z.string().optional(),
WORKSPACES_ROOT: z.string().optional(), // deprecated alias, remove next release
```

Consume as `SANDBOX_ROOT ?? WORKSPACES_ROOT`.

- [ ] **Step 3: Update all import paths and identifiers**, plus `.env.example`, `docker-compose.yml`, `.gitignore` and the `CLAUDE.md` directory-structure note.

- [ ] **Step 4: `npm run typecheck -w @polyant/engine` + `npm test -w @polyant/engine -- src/sandbox`** — expect PASS.

- [ ] **Step 5: Zero-residual check**

```bash
grep -rn 'WORKSPACES_ROOT' packages/engine/src   # expect only the deprecated-alias line in config.ts
grep -rn 'src/workspace' packages/engine/src     # expect 0
```

- [ ] **Step 6: Commit** — `refactor(engine): rename internal workspace sandbox term to sandbox`

---

## PR-1 — DB layer (migration 0073 + Drizzle strings + raw SQL)

**Why this split:** the migration renames DB tables/columns, so everything that names a DB string directly — Drizzle `pgTable("instances", …)` / `uuid("instance_id")` literals AND raw SQL — must change in the *same* commit or the app breaks. TS *symbols* stay put; they move in PR-2.

**Files:** create `packages/engine/src/database/migrations/0073_rename_instance_to_agent.sql`; modify the Drizzle literals in `instances/{schema,prompts.schema,instance-skills.schema,instance-tools.schema,secrets.schema,channels.schema,skill-env.schema}.ts`, `room/room.schema.ts`, `hooks/hooks.schema.ts`, `conversations/{schema,principal-secrets.schema}.ts`, `memory/schema.ts`, `analytics/traces.schema.ts`, `audit/audit.schema.ts`, `ai-gateway/logger.ts`, `knowledge/schema.ts`, `scheduled-tasks/schema.ts`, `optout/optout.schema.ts`, `webhooks/webhooks.schema.ts`, `server/oauth/oauth-states.schema.ts`; raw SQL in `authz/scope-filter.ts`, `utils/query-helpers.ts`.

- [ ] **Step 1: Discovery — verify the exact table/column set against the live DB**

```bash
docker exec polyant-postgres psql -U polyant -d polyant -tAc \
  "select table_name from information_schema.tables where table_schema='public' and table_name like 'instance%' order by 1"
docker exec polyant-postgres psql -U polyant -d polyant -tAc \
  "select table_name from information_schema.columns where table_schema='public' and column_name='instance_id' order by 1"
```

Reconcile against the Ground-Truth Inventory. Exclude tables that belong to unmerged branches (`instance_mcp_servers`) and any governance/`assistant_id` table (EE-only).

- [ ] **Step 2: Write the migration round-trip test (failing first)** — `packages/engine/src/database/0073-rename.integration.test.ts`: assert `agents` exists and `instances` does not; assert `conversations.agent_id` exists and `conversations.instance_id` does not.

- [ ] **Step 3: Run it to confirm FAIL.**

- [ ] **Step 4: Write `0073_rename_instance_to_agent.sql`** — one `BEGIN`/`COMMIT` transaction: 9 `ALTER TABLE … RENAME TO agent_*` + their `RENAME COLUMN instance_id TO agent_id`, then a `RENAME COLUMN` for each of the 17 name-keeping tables. Postgres auto-renames PK/FK constraints and indexes that reference the table, but **named** indexes keep their old string — add optional `ALTER INDEX … RENAME TO …` lines for cosmetic consistency.

- [ ] **Step 5: `npm run db:migrate -w @polyant/engine`** then re-run the round-trip test — expect PASS.

- [ ] **Step 6: Update Drizzle string literals only** — DB strings change, TS export/property names stay:

```ts
export const instances = pgTable("agents", { /* … */ });  // TS symbol still `instances`
uuid("instance_id") -> uuid("agent_id")                    // TS property `instanceId` stays
```

- [ ] **Step 7: Update raw-SQL DB-name references** — `authz/scope-filter.ts` (`from instances i` → `from agents i`, allowlist `instance_id`/`c.instance_id`/`al.instance_id` → `agent_id`/…, default param, doc comment); `utils/query-helpers.ts`; `authz/cross-org-isolation.integration.test.ts` raw `INSERT`/`DELETE`.

- [ ] **Step 8: `npm run typecheck -w @polyant/engine` + full engine suite** — classify every failure as REGRESSION vs TEST-OUTDATED against the recorded baseline.

- [ ] **Step 9: Zero-residual check (DB-name strings only)**

```bash
grep -rn 'pgTable("instance' packages/engine/src                          # expect 0
grep -rn '"instance_id"' packages/engine/src --include='*.schema.ts'      # expect 0
grep -rniE 'from instances\b|into instances\b|table instances\b' packages/engine/src \
  | grep -v database/migrations                                            # expect 0
```

(Historical migration files keep their old identifiers — they are an applied ledger and MUST NOT be edited.)

- [ ] **Step 10: Commit** — `feat(db): migration 0073 rename instances→agents (table+column layer)`

---

## PR-2 — Engine TS symbols

**Why a separate commit:** pure TypeScript identifier rename — no DB or wire change. Large but mechanical, verified by typecheck + the suite.

**Order (minimizes in-progress compile errors):**

1. `instances/identifiers.ts`: `InstanceSlug`→`AgentSlug`, `InstanceUuid`→`AgentUuid`, `asInstanceSlug`→`asAgentSlug`, `asInstanceUuid`→`asAgentUuid`.
2. `instances/schema.ts`: export `instances`→`agents`, type `Instance`→`Agent`, property `instanceId`→`agentId`; child schemas likewise.
3. `instances/resolve-instance-id.ts` → `resolve-agent-id.ts`: `resolveInstanceId`→`resolveAgentId`, `resolveInstanceSlug`→`resolveAgentSlug`.
4. Stores/services of the renamed tables (function/var names, params).
5. Controllers: dual prefix `@Controller(["api/agents/…", "api/instances/…"])` — back-compat.
6. `instances/defaults.ts` and the module directory — see the caveat below.

> ⚠️ **Directory-collision caveat:** `packages/engine/src/agents/` ALREADY exists (the AI-agent framework: `supervisor/`, `tools/`). Moving `instances/` wholesale there would merge config schema into the framework dir. **Decision:** rename symbols only and leave the module at `packages/engine/src/instances/`, as PR #125 did; a directory move is a separate, later refactor. File moves are the riskiest part — if attempted, do them last, after symbol renames are green, in their own commit.

- [ ] **Step 1: Rename branded identifiers in `identifiers.ts`, then `npm run typecheck -w @polyant/engine`** — the error list IS the worklist.

- [ ] **Step 2: Mechanically rename symbols module-by-module** in the order above. Per `.claude/rules/typescript-style.md`: named exports only, `.js` import extensions, kebab-case filenames. Use `git mv` to preserve history.

- [ ] **Step 3: Add the dual-prefix controllers + a back-compat test (failing first)** — assert `/api/agents` and `/api/instances` return the same body:

```ts
it("serves the agents list on both /api/agents and /api/instances", async () => {
  const viaAgents = await request(app.getHttpServer()).get("/api/agents").set(authHeader);
  const viaInstances = await request(app.getHttpServer()).get("/api/instances").set(authHeader);
  expect(viaAgents.status).toBe(200);
  expect(viaAgents.body).toEqual(viaInstances.body);
});
```

- [ ] **Step 4: typecheck + full engine suite + lint.** The custom ESLint rule `polyant/require-inject-in-nest-classes` must stay green — do not drop `@Inject(...)` during renames. `route-authorization-guardrail.test.ts` derives its controller list from the module graph, so new route prefixes must still carry a permission declaration.

- [ ] **Step 5: Zero-residual check**

```bash
grep -rn 'resolveInstanceId\|resolveInstanceSlug' packages/engine/src                       # expect 0
grep -rn 'InstanceSlug\|InstanceUuid\|asInstanceSlug\|asInstanceUuid' packages/engine/src   # expect 0
grep -rn '\binstanceId\b' packages/engine/src | grep -v '\.test\.'                          # review; ~0 in non-test
```

- [ ] **Step 6: Commit** — `refactor(engine): rename instance symbols to agent (types, stores, resolvers)`

---

## PR-3 — Web

**Files:** `lib/api.ts`, `lib/api-types.ts`, `lib/api.test.ts`, `lib/utils.ts`, the playground `stream-parser.ts`, the agent `settings-tab.tsx` (78 `/api/instances` call sites → `/api/agents`); move the `(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/instances/` route group to `agents/`; `next.config.ts` rewrites; sidebar/nav links and i18n keys.

- [ ] **Step 1: Update `next.config.ts` rewrites** — add `/api/agents/:path*`, keep `/api/instances/:path*` as a deprecated alias.

- [ ] **Step 2: Rewrite the call sites** (path prefix only — `api.instances` client namespace and `instances.*` i18n keys may stay; display text already reads "Agent").

- [ ] **Step 3: Move the route group + fix imports, links, redirects.**

```bash
git mv "packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/instances" \
       "packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/agents"
```

- [ ] **Step 4: `npm run typecheck -w @polyant/web` + `npm test -w @polyant/web` + `npm run build:web`** — expect PASS.

- [ ] **Step 5: Zero-residual check**

```bash
grep -rn '/api/instances' packages/web/src   # expect 0 (the alias lives only in next.config.ts)
grep -rn 'workspaces/\[workspaceSlug\]/instances' packages/web/src  # expect 0
```

- [ ] **Step 6: Commit** — `refactor(web): route admin UI through /api/agents and /agents/[slug]`

---

## PR-4 — Alias removal

**Precondition:** PR-1…PR-3 green. The only consumer of the deprecated `/api/instances/*` paths is the in-repo web, migrated in PR-3 — which is why the alias can be dropped inside the same PR rather than after a deprecation window. External API-key clients calling `/api/instances` directly ARE affected; call this out in the PR body as the one breaking change.

- [ ] **Step 1: Drop the dual prefix** from every `@Controller([...])`, and flip the PR-2 back-compat test to assert `/api/instances` now 404s.
- [ ] **Step 2: Remove the `/api/instances/:path*` rewrite** from `next.config.ts`.
- [ ] **Step 3: `npm run typecheck && npm test && npm run lint`**, then commit — `chore: remove deprecated api/instances alias and rewrite`.

**Note:** the `WORKSPACES_ROOT` deprecated env fallback from PR-0 is deliberately **kept** — its deprecation window has not elapsed, and removing it would break env-configured deployments.

---

## Docs

- [ ] `CLAUDE.md`: the DB table map, the directory structure, the branded-identifier convention, the Management API route list, and the sandbox path note.
- [ ] `GLOSSARY.md`: `instance` → `agent` as the canonical term; `workspace` reserved for the RBAC entity, `sandbox` for the filesystem scratch dir.
- [ ] `.env.example`: `SANDBOX_ROOT`.

## Execution record (2026-08-06)

Landed on `feat/rename-agent-domain` as five commits. Three deviations from the plan
above, all discovered during execution:

1. **`instanceId` is blocked on the plugin SDK, and is NOT in this branch.**
   `@polyant-ai/plugin-sdk@1.5.0` declares `ToolContext.instanceId: InstanceSlug`, and
   the engine's `ToolContext` satisfies it **structurally**, not by extension — so the
   property name is public plugin contract and renaming it breaks every third-party
   tool and hook at typecheck (~1200 engine occurrences, plus the JSON field). The
   plan never saw this: PR #125 predates the serialized plugin SDK landing on
   `develop`. Resolution: polyant-ai/polyant-sdk#10 ships the **additive** rename as
   **v1.6.0** (`AgentSlug`/`agentId`/`agent` with the old names kept as deprecated
   aliases, brand payload pinned so both names stay the same type). The engine follows
   once that is merged and tagged. The brand payload pin is documented in
   `instances/identifiers.ts` and in CLAUDE.md.

2. **No dual controller prefix, and no deprecated web rewrite.** PR-2's
   `@Controller(["api/agents", "api/instances"])` exists only so the web can migrate
   against a still-working old prefix across two separately-merged PRs. Everything
   lands in one PR here, so the alias would have been added and deleted a few commits
   apart — churn with no reviewer or deployment value. Controllers went straight to
   `api/agents`. External Management-API callers hitting `/api/instances` directly are
   the one breaking change, called out in the PR body.

3. **The migration and the raw-SQL list were both wider than the plan's inventory.**
   Live-DB discovery added `principal_secrets` and `oauth_states` (on top of
   `conversation_state`, which the 2026-06-21 plan had already caught), and raw-SQL
   joins on `instances` turned up in `conversations/store.ts` (3) and
   `analytics/analytics.store.ts` (1), neither of which the plan's file list named.
   `instance_mcp_servers` exists in the local dev DB but not on `develop` — excluded,
   with the hand-off documented in the migration header.

**Verification actually run** (baseline recorded on `develop` first: engine 2524 tests,
web 498, typecheck clean):

- Migration 0073 applied onto a **fresh** database through the whole 0001→0073 chain;
  the round-trip integration test fails at 0072 and passes at 0073.
- Engine: `typecheck` ✓, **207 files / 2552 tests** ✓, `lint` 0 errors (513 warnings,
  same as baseline).
- Web: `typecheck` ✓, **50 files / 498 tests** ✓, `build:web` ✓ (routes render as
  `/organizations/[orgSlug]/workspaces/[workspaceSlug]/agents[/[slug]]`), `lint` 0 errors.
- Zero-residual greps green for: `pgTable("instance`, `"instance_id"` in schemas, raw
  SQL naming `instances`, `WORKSPACES_ROOT` (outside the deprecated fallback),
  `src/workspace`, `/api/instances` (outside historical migration comments), and the
  old web route path.

Test failures encountered were all **TEST OUTDATED**, never regressions: `vi.mock`
factories keying the mocked Drizzle schema module by its old export name (untyped, so
`tsc` could not see them) and mocks/assertions carrying the old response envelope.

## Self-Review

**Coverage:** sandbox rename ✓ PR-0; DB ✓ PR-1; engine ✓ PR-2; web ✓ PR-3; alias removal ✓ PR-4; docs ✓.

**Deviations from the 2026-06-21 plan (deliberate):** base is `develop`, not `feat/rbac-epic`; migration is **0073**; inventory adds `conversation_state`, `principal_secrets`, `oauth_states`; `instance_mcp_servers` excluded with a documented hand-off; the engine `instances/` directory move is explicitly out of scope; `develop` is CI-gated so the local gates are corroborated rather than sole.

**Type consistency:** `resolveAgentId`/`resolveAgentSlug`, `AgentSlug`/`AgentUuid`, `asAgentSlug`/`asAgentUuid`, `agents`/`Agent`, `agent_id` — used consistently across PR-1…PR-3.
