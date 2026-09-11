# Polyant

Polyant is an open-source, domain-agnostic platform for building AI assistants. It is an
npm-workspaces monorepo with a NestJS runtime (`packages/engine`) and a Next.js admin panel
(`packages/web`). Assistant behaviour comes from PostgreSQL data, not instance-specific
code or files.

## Working agreement

- The user's current request overrides repository guidance when they conflict.
- Inspect the relevant code, tests, package manifest, and recent history before editing.
- Prefer the smallest change at the shared root cause. Do not add speculative abstractions.
- Preserve unrelated changes in dirty worktrees. Never discard or overwrite work you did
  not create.
- Do not push, open or merge a PR, publish, tag, or release unless the user explicitly asks.
- Before claiming completion, run the narrowest relevant checks and report anything that
  could not run.

## Sources of truth

Use this order when documentation disagrees:

1. Executable code, schema, migrations, tests, and CI.
2. Package manifests and lockfile for versions and commands.
3. Current ADRs and reference documentation.
4. This file and path-scoped rules.
5. Historical prose and Git history.

Do not preserve a contradicted statement merely because it appears in an old plan or spec.
Temporary implementation plans do not belong in the repository after the work lands.
Record durable architectural decisions in `docs/adr/`; Git is the archive.

## Commands

Run dependency installation from the repository root.

```bash
npm run dev                 # engine
npm run dev:web             # web panel
npm run build               # all workspaces
npm run lint
npm run typecheck
npm test
npm run test:unit
npm run test:integration
npm run db:generate
npm run db:migrate
docker compose up -d
```

Use workspace targeting for narrow checks, for example:

```bash
npm run typecheck -w @polyant/engine
npm run test -w @polyant/web
npx vitest run --root packages/engine path/to/file.test.ts
```

The scripts in `package.json` are authoritative. Do not copy dependency versions into
instructions; read the relevant manifest.

## Repository map

```text
packages/engine/src/
  index.ts                 boot sequence and pipeline wiring
  agents/                  supervisor and built-in tools
  ai-gateway/              provider-independent chat boundary
  embeddings-gateway/      provider-independent embeddings
  instances/               instance data and configuration resolution
  hooks/                   lifecycle hook definitions and runner
  plugin-system/           plugin discovery and loading
  channels/                channel adapters
  server/                  NestJS HTTP bridge
  database/                client and migrations

packages/web/src/
  app/                     Next.js App Router routes
  components/ui/           source-owned shadcn components
  lib/api.ts               web-to-engine request boundary
  lib/tenant/              URL and workspace resolution
```

Further references:

- `README.md` and `CONTRIBUTING.md`: product setup and contribution workflow.
- `docs/plugins.md`: public plugin contract.
- `docs/UPGRADING.md`: upgrade guidance.
- `docs/adr/`: current architectural decisions.
- `.claude/skills/backend-architecture/SKILL.md`: backend change workflow.
- `.claude/skills/frontend-design-system/SKILL.md`: frontend change workflow.
- `.claude/skills/plugin-authoring/SKILL.md`: tool, hook, and plugin authoring.

## Architecture boundaries

- Keep the product domain-agnostic. Prompts, skills, tool enablement, secrets, channels,
  and assistant settings are per-instance database data.
- `packages/engine/src/server/` is the NestJS HTTP bridge. Runtime/domain logic stays in
  domain modules and must not depend on HTTP request or response objects.
- Components request the AI gateway by capability/tier, not by hard-coded provider model.
  Keep direct AI SDK calls inside `ai-gateway/providers/base.ts`.
- A built-in tool is a `*.tool.ts` default export created with `defineTool(...)`; a built-in
  hook is a `*.hook.ts` default export created with `defineHook(...)`. Discovery happens at
  boot. See `docs/plugins.md` before changing this contract.
- `replyHandled` and `replyText` are reserved tool-result fields because the supervisor may
  use them as the user-visible reply.
- Post-response work is asynchronous and commit-on-success. Preserve the abort gate and
  the distinction between records written before and after it.
- All web-to-engine API calls go through `request<T>()` in `packages/web/src/lib/api.ts`,
  which attaches the workspace slug. A component-level `fetch` can target the wrong tenant.
- Outbound requests that use an Undici dispatcher go through the safe HTTP helpers in
  `packages/engine/src/utils/safe-http.ts`.

## Data and configuration

- Validate process configuration in `packages/engine/src/config.ts`; do not scatter direct
  `process.env` reads. Existing documented test seams and subprocess filters are exceptions.
- Tenant- or instance-specific values are rows with a process default, not deployment-only
  environment variables.
- Instance slugs and UUIDs are distinct branded identifiers. Convert only through the
  instance resolver functions; do not guess from a string.
- Tenant predicates fail closed. A missing organization/workspace identifier must never
  remove a query filter and expose all rows.
- Migrations and `packages/engine/src/database/migrations/meta/_journal.json` are updated
  together. Follow the next existing migration number and verify both directions.
- The root `.env` serves the engine and Docker Compose. Next.js local auth configuration
  belongs under `packages/web/.env.local`.
- Never commit secrets or log credentials, tokens, message bodies, or other PII at normal
  production log levels. Keep access metadata and stable IDs separate from payload data.

## TypeScript and package boundaries

- The engine is Node ESM: relative value imports end in `.js`.
- The web app is bundled by Next.js: relative imports under `packages/web/src` are
  extensionless. Custom ESLint rules enforce both directions.
- NestJS constructor dependencies require explicit `@Inject(...)`; the engine ESLint rule
  enforces this because `tsx` does not emit decorator metadata.
- Follow existing identifier, schema, export, and file-name patterns in the touched module.
  Do not impose a repository-wide rule contradicted by nearby code.
- Never edit generated or vendored files by hand. Regenerate them using the owning script.

## Scoped guidance

Claude Code loads these rules when matching files are read. Other agents should open the
same file before changing that scope:

- Engine TypeScript: `.claude/rules/engine.md`
- Web TypeScript/React: `.claude/rules/web.md`
- Tests: `.claude/rules/tests.md`
- Database migrations: `.claude/rules/migrations.md`

Skills are task procedures, not an extra source of product truth. They must be safe to run
twice, inspect current state before mutation, and use repository scripts instead of assuming
a particular agent or shell alias.

## Git and releases

- Work on a topic branch from the intended base. `develop` is integration; `main` carries
  releases. Never push directly to either protected branch.
- Use focused conventional commits in English and add the DCO sign-off with `git commit -s`.
- Check the current branch and staged diff immediately before every commit.
- Before any release preparation, promotion, tag, or publication, load
  `.claude/skills/release/SKILL.md`. Release publication always requires an explicit final
  confirmation of the version and immutable target SHA.
