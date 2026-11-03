# Polyant

Polyant is an open-source, domain-agnostic platform for building AI assistants: an
npm-workspaces monorepo with a NestJS runtime (`packages/engine`) and a Next.js admin panel
(`packages/web`). Assistant behaviour comes from PostgreSQL data, not instance-specific
code or files.

## Working agreement

- The user's current request overrides repository guidance when they conflict.
- Inspect the relevant code, tests, manifest, and recent history before editing.
- Make it work, then make it good: before asking for review, simplify. Reuse what exists,
  remove duplication and dead code, keep the diff small and at the shared root cause.
- Verify with the repository scripts and report anything that could not run.
- Fill every section of the pull request template.
- Preserve unrelated changes in dirty worktrees. Never discard work you did not create.
- Do not push, open or merge a PR, publish, tag, or release unless the user explicitly asks.

## Sources of truth

Use this order when documentation disagrees:

1. Executable code, schema, migrations, tests, and CI.
2. Package manifests and lockfile for versions and commands.
3. Current ADRs and reference documentation.
4. This file and path-scoped rules.
5. Historical prose and Git history.

Do not preserve a contradicted statement because an old plan or spec says it. Temporary
plans leave the repository when the work lands; durable architectural decisions go in
`docs/adr/`; Git is the archive.

## Commands

Install from the repository root. The scripts in `package.json` are authoritative; target
one workspace for narrow checks (`npm run typecheck -w @polyant/engine`,
`npx vitest run --root packages/engine path/to/file.test.ts`). Lint and typecheck through
the package scripts: their ESLint rules differ per workspace.

## Architecture boundaries

- Keep the product domain-agnostic. Prompts, skills, tool enablement, secrets, channels,
  and assistant settings are per-instance database data.
- `packages/engine/src/server/` adapts HTTP to domain functions. Domain logic never
  depends on request or response objects.
- Callers request the AI gateway by capability or tier, never by model name. Direct AI SDK
  calls stay in `ai-gateway/providers/base.ts`.
- Built-in tools and hooks are `*.tool.ts` / `*.hook.ts` default exports of
  `defineTool(...)` / `defineHook(...)`, discovered at boot. Read `docs/plugins.md` before
  changing that contract.
- `replyHandled` and `replyText` are reserved tool-result fields: the supervisor may use
  them as the user-visible reply.
- Post-response work is asynchronous and commit-on-success. Preserve the abort gate and
  the records intentionally written before it.
- Every web-to-engine call goes through `request<T>()` in `packages/web/src/lib/api.ts`,
  which attaches the workspace slug.
- Outbound requests with an Undici dispatcher use `packages/engine/src/utils/safe-http.ts`.

## Data and configuration

- Validate process configuration in `packages/engine/src/config.ts`; do not scatter
  `process.env` reads. Tenant- or instance-specific values are rows with a process default.
- Instance slugs and UUIDs are distinct branded identifiers; convert only through the
  instance resolvers.
- Tenant predicates fail closed: a missing organization or workspace identifier never
  removes a query filter.
- A SQL migration and `database/migrations/meta/_journal.json` change together.
- The root `.env` serves the engine and Docker Compose; Next.js local auth configuration
  lives in `packages/web/.env.local`.
- Never commit secrets or log credentials, tokens, message bodies, or PII at normal
  production levels. Keep stable IDs separate from payload data.
- Follow the touched module's identifier, schema, export, and file-name patterns. Never
  edit generated or vendored files by hand; use the owning script.

## Scoped guidance and skills

Path rules live in `.claude/rules/`; read the matching file before changing that scope:
`engine.md` (engine TypeScript and scripts), `web.md` (web source), `tests.md` (tests and
test configuration), `migrations.md` (migrations and schemas).

Task procedures live in `.claude/skills/<name>/SKILL.md` (linked from `.agents/skills/`):
backend architecture, frontend design system, plugin authoring, and release. Skills are
procedures, not product truth: they inspect state before mutating it, are safe to run
twice, and use repository scripts.

## Git and releases

- Work on a topic branch from the intended base. `develop` is integration; `main` carries
  releases. Never push directly to either.
- Use focused conventional commits in English. Check the branch and staged diff before
  every commit.
- Before any release preparation, promotion, tag, or publication, load the release skill.
  Publication requires an explicit final confirmation of the version and target SHA.
