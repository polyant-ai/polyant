# Polyant (Monorepo)

Open-source platform for building AI assistants with long-term memory, multi-channel support, and per-instance customization. TypeScript/Node.js (ESM). npm workspaces monorepo.

## Tech Stack

- **Monorepo**: npm workspaces (`packages/engine`, `packages/web`)
- **packages/engine** (AI runtime + management API):
  - Agent Framework: Vercel AI SDK v6 (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`)
  - HTTP Server: NestJS 11 (OpenAI-compatible API + Management REST API)
  - Encryption: AES-256-GCM (Node.js crypto) for skill env vars and instance secrets
  - Database: PostgreSQL 16 with Drizzle ORM + pgvector + Full-Text Search (tsvector)
  - Memory: Native LLM extraction + pgvector (cosine similarity) + PostgreSQL FTS
  - Channels: Telegram (grammY), Slack (@slack/bolt), WhatsApp (WAHA)
  - Tracing: LangSmith
  - Validation: Zod
  - **Architecture patterns**: see `.claude/skills/backend-architecture/SKILL.md` for full reference (functional pipeline + NestJS bridge, tier-based AI gateway, self-registering tools, domain-oriented modules)
- **packages/web** (admin panel):
  - Next.js 16 (App Router)
  - React 19
  - Tailwind CSS 4 (CSS-first config, no tailwind.config)
  - shadcn/ui (new-york style, source-owned components)
  - lucide-react (icons)
  - next-themes (light/dark mode, localStorage)
  - **Design system**: see `.claude/skills/frontend-design-system/SKILL.md` for full reference (inspired: black primary, white-dominant, accent-only color)

## Commands

All commands can be run from the monorepo root. They delegate to the appropriate workspace.

```bash
# Engine (AI runtime)
npm run dev              # Start engine with tsx watch
npm run dev:engine       # Same as above (explicit)
npm run build:engine     # Compile engine TypeScript
npm start                # Run engine from dist/

# Web (admin panel)
npm run dev:web          # Start Next.js dev server
npm run build:web        # Build Next.js for production

# All workspaces
npm run build            # Build all packages
npm run lint             # ESLint all packages
npm run typecheck        # TypeScript check all packages
npm test                 # Run all tests

# Database (engine)
npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Apply migrations
npm run db:studio        # Drizzle Studio GUI

# Engine tests
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests
npm run test:functional  # Functional tests

# Infrastructure
docker compose up -d     # Start postgres (pgvector), open-webui
```

### Per-workspace commands

You can also run commands directly in a workspace:

```bash
npm run dev -w @polyant/engine
npm run build -w @polyant/web
npm run typecheck -w @polyant/engine
```

## Directory Structure

```
packages/
├── engine/src/          # @polyant/engine — NestJS
│   ├── index.ts                 # Boot sequence + message pipeline
│   ├── config.ts                # Zod-validated env config
│   ├── ai-gateway/              # Provider-agnostic LLM abstraction (tier-based) + providers/
│   ├── agents/                  # supervisor/, tools/ (*.tool.ts + registry)
│   ├── hooks/                   # Conversation lifecycle hooks (*.hook.ts + runner)
│   ├── plugin-system/           # Plugin roots, manifests
│   ├── memory/ knowledge/       # pgvector + FTS, hybrid search; documents + chunks
│   ├── embeddings-gateway/      # Per-instance embedder, dim columns, reset-on-switch
│   ├── conversations/           # Message store + FTS + conversation state store
│   ├── instances/               # Instance CRUD, secrets, channels, config resolver
│   ├── channels/adapters/       # Telegram, Slack, WhatsApp
│   ├── room/ webhooks/          # Event-driven agent workspace; external event ingestion
│   ├── scheduled-tasks/ analytics/ activity-stream/ management-audit/
│   ├── auth/ authz/ organizations/   # Session auth; RBAC; tenancy roots
│   ├── server/                  # NestJS controllers ONLY — the HTTP bridge
│   └── database/                # Drizzle client + migrations
│
└── web/src/             # @polyant/web — Next.js App Router
    ├── app/(admin)/organizations/[orgSlug]/…   # Tenant-scoped admin routes
    ├── components/ui/           # shadcn/ui (managed by the CLI)
    ├── lib/tenant/              # The ONLY place URL shape and tenancy resolution live
    └── proxy.ts                 # Auth middleware (Next 16 renamed middleware→proxy)
```

Two rules the tree does not show. `packages/engine/src/server/` holds NestJS controllers
and nothing else — the pipeline is functional, and DI must not leak out of that directory.
`packages/engine/workspaces/` is NOT configuration: it is the per-conversation sandbox for
the file tools (`workspaces/<instanceId>/conversations/<convId>/`, gitignored).

## Instance Configuration (Database-First)

**All instance configuration is stored in PostgreSQL — NOT on the filesystem.**

| Config | DB Table | Notes |
|--------|----------|-------|
| Prompts (7 sections) | `instance_prompts` | Seeded from `instances/defaults.ts` on create; the old editable `08-datetime` section is gone — datetime injection is the per-instance `datetime_injection_enabled` flag |
| Skills (global catalog) | `skills` + `skill_versions` | CRUD via `/api/skills` |
| Skills (per-instance) | `instance_skills` | Enable/disable, version pinning, env vars |
| Tools (global catalog) | `tools` | Self-registered at boot from `*.tool.ts` |
| Tools (per-instance) | `instance_tools` | Auto-recomputed when skills change |
| Secrets | `instance_secrets` | AES-256-GCM encrypted |
| Channels | `instance_channels` | Telegram, Slack, WhatsApp config |
| Room config | `instance_room` | One-to-one with instance, prompt + outbound channel |
| Event sources | `event_sources` + `event_definitions` | Webhook-based, config AES-256-GCM encrypted |
| Event backlog | `event_backlog` | pending → processing → completed lifecycle |
| Activity log | `room_activity_log` | Auto-compacted: 7d daily → weekly → monthly |
| Hooks | `instance_hooks` | Lifecycle event → action (v1: run tool), template args, per-event ordering |

**IMPORTANT — DO NOT use filesystem for any agent configuration:**
- Prompts are read via `getPrompts(instanceId)` from `prompts.store.ts` (60s TTL cache)
- Skills are discovered via DB joins in `supervisor/prompt.ts` → `discoverSkills()`
- Tool enablement is resolved via `getEnabledToolNames()` from `instance-tools.store.ts`
- Knowledge documents live exclusively in PostgreSQL (`knowledge_documents` + `knowledge_chunks`)
- The `workspaces/` directory holds **only** per-conversation tool sandboxes (`workspaces/<id>/conversations/<convId>/`) used by `readFile` / `writeFile` / `gitCloneRepo`
- There is no `_template/` directory — new instances are seeded from DB defaults (`instances/defaults.ts`)

**When adding a new tool:** create a `*.tool.ts` file in `packages/engine/src/agents/tools/` that `export default defineTool({ name, description, parameters, execute })` from `@polyant-ai/plugin-sdk`. `parameters` is a **static** Zod schema (must not read `ctx`) that `defineTool` serializes to JSON Schema at module load; `execute(input, ctx)` holds the business logic. The loader (`loadAllTools()`) collects the default export at boot — no other files need to be modified. The `tools` DB table is synced automatically. The legacy `registerTool({ create: (ctx) => ({ parameters, execute }) })` self-registering shape is GONE: the loader (`registry.ts`'s `importRoot`) only recognizes a default export with `inputSchema` (the `defineTool` shape) and silently skips anything else with a console warning — there is no compatibility path left, so a tool must be migrated to `defineTool` to load at all. See [docs/plugins.md](docs/plugins.md) and the `plugin-authoring` skill.

**When adding a new skill:** use the Management API (`POST /api/skills`) or create entries in the `skills` + `skill_versions` tables. Never create skill files on disk.

**When modifying prompts:** use the Management API (`PATCH /api/instances/:slug/prompts`) or update `instance_prompts` rows. Default prompt content for new instances is defined in `packages/engine/src/instances/defaults.ts`.

## Key Conventions

Rules, not descriptions. Everything here is falsifiable and cannot be read off the code;
the *reasoning* behind the heavier ones lives in
`.claude/skills/backend-architecture/references/` and is loaded on demand, not on every
turn. Where a rule has an automated enforcement, it is named — a rule with no enforcement
and no rationale is a wish, and belongs in neither file.

### Language and build

- **ESM only** (`"type": "module"` in package.json, `.js` extensions in imports)
- **npm workspaces**: always run `npm install` from the monorepo root. Use `-w <package>` to target a specific workspace
- **Single `.env` at monorepo root**: shared by engine and docker-compose. Engine finds it via `import.meta.url`-based path resolution (searches package root, then monorepo root)
- **Config via Zod**: all env vars parsed and validated in `packages/engine/src/config.ts`. Never read `process.env` directly elsewhere (documented exceptions: `DEFAULT_INSTANCE_ID`, `WORKSPACES_ROOT`, `LOG_LEVEL`). Other deliberate reads (subprocess env filters, default params for testability, tool-registry `requiredEnv` discovery) carry a `// CONVENTION-EXCEPTION:` comment and must stay confined to those patterns
- **tsx does not support `emitDecoratorMetadata`**, so every NestJS constructor parameter needs an explicit `@Inject(ClassName)` — implicit type-based injection silently resolves to `undefined`. *Enforced* by the custom ESLint rule `polyant/require-inject-in-nest-classes`; plain classes instantiated with `new` (the channel adapters) are exempt by design
- **Migrations are written by hand and the journal is updated by hand.** `drizzle-kit generate` only works through `npm run db:generate` (an ESM workaround), and with no snapshot files it emits a full-schema migration every time. A `00NN_*.sql` file with no matching entry in `meta/_journal.json` is **silently skipped** by `db:migrate` — which reports success. The `tag` must equal the filename without `.sql`, and `when` must be greater than every entry already applied to the target database, or the same silent no-op occurs
- **Next.js loads `.env` only from `packages/web/`**, never the monorepo root: auth vars (`AUTH_SECRET`, `DATABASE_URL`, `GOOGLE_*`) belong in `packages/web/.env.local`
- **Next 16**: the auth middleware is `packages/web/src/proxy.ts` (renamed from `middleware.ts`), web lint is `eslint .` against flat config (`next lint` is gone), and the root `overrides.next` MUST track the installed Next major or next-auth pulls in a second copy of `next`

### Architecture

- **Framework-first, never instance-specific.** Polyant builds assistants of any kind, so code — tools, prompt templates, supervisor logic, pipeline — must be domain-agnostic. Instance behaviour comes from per-instance data: prompts, skills, tool enablement, secrets. A defect seen in one instance is fixed as a general mechanism any instance can use, never as a branch for that instance
- **Instance configuration is DATABASE-first, never the filesystem** — prompts, skills, tool availability, secrets, channels are rows, not files. `packages/engine/workspaces/` is the per-conversation sandbox for the file tools and nothing else
- **Components ask for a `fast | standard | heavy` tier, never a model name.** The mapping is `ai-gateway/config.ts`; per-`(provider, model)` pricing and capabilities live in one catalog, `ai-gateway/model-catalog.ts`, and every capability gate is a lookup into it. A model-id regex in a provider file is a bug — see `references/ai-gateway.md`
- **A tool is one `*.tool.ts` default-exporting `defineTool(...)`**; a hook is one `*.hook.ts` default-exporting `defineHook(...)`. The loader finds both at boot; nothing else needs editing. Tool `parameters` must satisfy OpenAI strict mode — no `.optional()`, `.default()`, `.url()`/`.email()`, or unbounded `z.record`. *Enforced* by `agents/tools/strict-mode.test.ts`, which inspects every registered tool: if it fails, fix the schema, never soften the check. See `references/tools-and-hooks.md`
- **Post-processing is fire-and-forget and commit-on-success**: messages, summary, memory and state are written after the reply, and an aborted turn writes nothing at all
- **Independent deployment**: each package under `packages/` is deployable as a standalone service
- **A WhatsApp channel authenticates to Twilio in one of two `authMode`s** (`authToken` or `apiKey`), each validated on its own inbound route with its own secret; `webhookSecret` is server-minted and never client-suppliable. See `references/channels.md`

### Data

- **A slug is not a UUID, and the compiler now knows.** `ToolContext.instanceId` is the SLUG. Slug-text tables (conversations, memories, knowledge, traces, logs, scheduled tasks) take `InstanceSlug`; uuid-FK tables (prompts, secrets, channels, instance_skills, instance_tools, room, webhooks) take `InstanceUuid`. The only sanctioned conversion is `resolveInstanceId` / `resolveInstanceSlug`. Passing the wrong one used to mean a silent zero-row query; the brands in `instances/identifiers.ts` make it a type error
- **PostgreSQL FTS uses the `simple` config** (no language stopwords) so search works across languages
- **Hybrid search fuses pgvector cosine similarity with PostgreSQL FTS via Reciprocal Rank Fusion**
- **Memory extraction runs only when the instance's `memoryEnabled` is set.** It is fire-and-forget: an LLM extracts facts as JSON, they are embedded and upserted with cosine-similarity dedup at 0.90. Relative dates are converted to absolute, and facts are written in the conversation's language
- **Skills live in `skills` + `skill_versions`**, assignments in `instance_skills`. Never create a skill file on disk
- **Sub-agents are ad-hoc and one hop deep**: `spawnTask` (`agents/tools/task-tool.ts`) composes a sub-agent on the fly with the parent's tools minus `spawnTask` itself — 15 steps for the supervisor, 10 for the sub-agent. There is no registry of named, typed sub-agents; the `agents/sub-agents/` module that once held one is gone. Agent-to-agent goes through the `agent` channel instead, as `ask_<slug>` tools

### Where the rest lives

Loaded on demand, not on every turn. Each file holds the reasoning and the failure modes
behind the rules above.

| Topic | Reference |
|---|---|
| Model catalog, prompt caching, provider adapters, AI SDK v6 boundary | [`references/ai-gateway.md`](.claude/skills/backend-architecture/references/ai-gateway.md) |
| Burst coordination, cancellation, conversation state, debug capture, typed SSE | [`references/pipeline.md`](.claude/skills/backend-architecture/references/pipeline.md) |
| Embedder independence, the destructive embedder switch, AWS secret namespaces, export/import | [`references/instances.md`](.claude/skills/backend-architecture/references/instances.md) |
| Channel adapters, GDPR opt-out | [`references/channels.md`](.claude/skills/backend-architecture/references/channels.md) |
| Tool registry, lifecycle hooks, plugins, MCP | [`references/tools-and-hooks.md`](.claude/skills/backend-architecture/references/tools-and-hooks.md) |
| Logging, audit, room, webhooks, scheduling, workspace credentials | [`references/operations.md`](.claude/skills/backend-architecture/references/operations.md) |

Per-feature design records — the decision, the alternatives, the trade-offs — are in
`docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Development Workflow

### Before starting important features

- Use `/brainstorming` to explore intent, requirements, and design before writing code
- For multi-step features, write an **openspec** (spec document) before implementation to align on scope and approach

### After completing a feature

- **Test coverage**: review existing tests — migrate or update tests broken by the changes, and write new tests for the added code. Aim for meaningful coverage, not just happy paths
- **Typecheck + lint**: run `npm run typecheck` and `npm run lint` before considering the feature done
- **DB migrations**: if Drizzle schema was modified, run `npm run db:generate` and review the generated migration before applying
- **Config sync**: if new env vars were added, ensure they are in `packages/engine/src/config.ts` (Zod schema) and documented in `.env` / `docker-compose.yml` as needed

### After completing a feature (knowledge capture)

Write down what the code cannot say: a decision and its reason, a trap that is not
inferable, an enforcement that exists. Not what happened — the PR and the git history
already hold that.

**Where it goes decides itself.** A *rule* someone must follow goes in CLAUDE.md, in one or
two lines, naming its enforcement. The *reasoning* behind it goes in a
`.claude/skills/backend-architecture/references/` file. A *decision with alternatives and
trade-offs* goes in `docs/superpowers/specs/`. This file is read in full on every turn; the
others are read when they are needed.

**Every addition to CLAUDE.md must compress or replace something.** That is not tidiness:
this file was 87 KB once — around 22k tokens on every request — because entries arrived as
PR summaries and none ever left. Model instruction-following degrades as input grows, so
past a few hundred lines the rules stop being read, and the ones that stop being read first
are the sharp specific ones you most wanted followed. If an entry has become a story about
how something was fixed, rewrite it as the invariant and move the story.

## Authentication & Authorization

Hierarchy: **Organization > Workspace > Agent** (the agent table is still named
`instances`). "Project" in the original design was renamed Workspace; there is no
`projects` table.

**Authentication.** A human signs in with **email + password** (Credentials, seeded from
`INITIAL_ADMIN_*` at boot) or, when its client id and secret are configured, with **Google
OAuth** — neither is mandatory in code, but disabling both leaves no way in. Either way the
human carries an Auth.js session (encrypted JWE), which the engine
decrypts with `AUTH_SECRET` and no per-request DB query — the strategy is JWT because
Next.js middleware runs in the Edge Runtime and cannot open a TCP/DB connection. An agent
caller carries that agent's `auth_api_key` (`instance_secrets` + the `authEnabled` flag) and
reaches `/v1/*` only. `AUTH_SECRET` must be byte-identical in both packages.

**Authorization is ENFORCED UNCONDITIONALLY. There is no shadow mode and no
`AUTHZ_ENFORCE` flag** — a denial is a 403, including on a route that declares no
permission at all. The flag existed once, defaulted to shadow, and shipped that way in
`.env.example`, so installs that copied the sample ran with every `@RequirePermission`
reduced to a no-op. It was deleted rather than re-defaulted.

- **Three declarations satisfy the guard**, and `route-authorization-guardrail.test.ts`
  accepts exactly the same three — keep them in lockstep, and note the test DERIVES its
  route list from the NestJS module graph rather than a hand-kept array: `@RequirePermission()`,
  `@RequireRole()` (deployment-level, hard-denies with no shadow mode), `@AuthenticatedOnly()`
  (the principal must be a HUMAN — API keys are denied; it is deliberately not `@Public()`).
  Anything else fails closed
- **Never inline a permission string.** `authz/permissions.ts` is the single source shared
  by the migration seed and the tests
- **Binding resolution is most-specific-wins**: a workspace binding both grants what the
  org binding lacks and revokes what it grants. No applicable binding → deny
- **Principal order** (`permission.guard.ts`): management API key → Platform Admin →
  per-instance API key → human user. Platform Admin is `users.is_platform_admin`, read from
  the DB per request and deliberately NOT in the JWT, so revocation is near-immediate
- **Membership is granted deliberately — signing in provisions NOTHING.** The member
  endpoint writes BOTH the `organization_memberships` row (which stamps `orgId` into the
  JWT) and the `role_bindings` row (which `can()` reads). A binding without a membership is
  a member who resolves no scope and is denied everywhere. Auto-provisioning existed once
  and made every employee passing the domain allowlist an Owner
- **EE seams**: `AuthorizationStrategy` and `EntitlementService`. In OSS builds
  `isAvailable()` is always `false`, so `@RequiresFeature()` routes fail closed

**`AUTH_MODE=alb-oidc` is UNUSABLE — do not deploy it.** A gateway principal has no local
`users` row to map its Cognito `sub` onto, so it carries no `orgId` and no bindings, and
under unconditional enforcement it is denied on every permission route. The missing piece is
the gateway-identity → local-user mapping, not a patch at the guard. Use `AUTH_MODE=session`.
See [ADR-0001](docs/adr/0001-gateway-authenticated-mode.md).

The reasoning behind all of the above — the reversed decisions especially, since those are
the ones most likely to be reinvented — is in
[`references/auth-and-rbac.md`](.claude/skills/backend-architecture/references/auth-and-rbac.md).
Tenant URL tiers are [ADR-0002](docs/adr/0002-canonical-tenant-boundaries.md).

### Environment variables for auth

| Variable | Required | Description |
|----------|----------|-------------|
| `INITIAL_ADMIN_PASSWORD` | Yes (engine) | Seeds the first admin account at boot. Without it no admin is seeded — seeding is skipped rather than auto-generating a password into the logs |
| `INITIAL_ADMIN_EMAIL` | No (engine) | Email of that account (defaults to `administrator@local`) |
| `AUTH_INTERNAL_SECRET` | Yes (web + engine) | Shared secret the web's Credentials provider uses to call the engine. Unset disables email/password sign-in, leaving Google as the only path |
| `GOOGLE_CLIENT_ID` | No (web) | Google OAuth client id — omit to hide the Google button |
| `GOOGLE_CLIENT_SECRET` | No (web) | Google OAuth client secret |
| `AUTH_SECRET` | Yes (web + engine) | Auth.js JWT encryption secret (32+ random chars). Must be identical in both packages — engine uses it to decrypt JWE tokens |
| `AUTH_TRUST_HOST` | No | Set to `true` behind reverse proxy |
| `DATABASE_URL` | Alt (web) | PostgreSQL connection string for Auth.js adapter. Web needs this in `.env.local` or root `.env` (Next.js doesn't auto-load monorepo root `.env`) |
| `PLATFORM_ADMIN_EMAIL` | No | Email promoted to Platform Admin at every boot (idempotent, no-op until that user exists) |

## Instances Architecture

An **instance** (an agent) is a shared assistant configuration — personality, tools,
skills, secrets, channels — that serves many users. It is addressed by its **slug**
everywhere outside the database: the API `model` field, the `:slug` URL segment, channel
keys, workspace directories, the `conversationId` prefix. See the identifier rule under
Key Conventions → Data before writing any query.

The HTTP surface is not listed here. `grep -rn '@Controller' packages/engine/src/server/`
answers it in a second and cannot go stale; a hand-maintained endpoint list in this file
could only ever be a copy that has already drifted.

## Development Layers (Claude Code)

Layered helpers under `.claude/`:

- **`rules/`** — enforced constraints, always loaded: coding style, security, testing, git workflow, performance, TypeScript conventions
- **`hooks/`** — automatic enforcement: pre-commit secret scan, post-edit lint, console.log warning
- **`agents/`** — 8 specialized agents (planner, code-reviewer, architect, tdd-guide, security-reviewer, doc-updater, build-error-resolver, refactor-cleaner)
- **`contexts/`** — behavioural modes: `dev`, `review`, `research`
- **`commands/`** — `/plan`, `/tdd`, `/brainstorming`, `/review`, `/verify`, `/security-scan`
- **`skills/`** — project knowledge, loaded on demand: `backend-architecture` (and its `references/`), `frontend-design-system`, `plugin-authoring`, and the four release skills
