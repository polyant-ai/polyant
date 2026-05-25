# Contributing to Polyant

Thank you for your interest in contributing! This document covers everything you need to get started.

## Prerequisites

- **Node.js 22+** — `node --version` should show v22 or higher
- **Docker & Docker Compose** — used to run PostgreSQL with pgvector
- **PostgreSQL 16 client** (optional, for direct DB access)

## Local Setup

### 1. Clone the repository

```bash
git clone https://github.com/polyant-ai/polyant.git
cd polyant
```

### 2. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL 16 with the pgvector extension on port 5432.

### 3. Install dependencies

Always install from the monorepo root — never inside a package directory.

```bash
npm install
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

| Variable | Description |
|----------|-------------|
| `ENCRYPTION_KEY` | 32-byte hex key — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `AUTH_SECRET` | Random string for JWT signing — generate with `openssl rand -base64 32` |

For the web frontend, create `packages/web/.env.local` with the Google OAuth credentials (see `.env.example` for the variable names).

### 5. Run database migrations

```bash
npm run db:migrate
```

### 6. Start development servers

```bash
# Terminal 1 — engine (NestJS, port 4000)
npm run dev

# Terminal 2 — admin panel (Next.js, port 3001)
npm run dev:web
```

Open the admin panel at `http://localhost:3001` and create your first instance.

## Project Structure

```
polyant/
├── packages/
│   ├── engine/   # NestJS — AI runtime, management API, channels
│   └── web/      # Next.js — admin panel
└── examples/     # Minimal working examples (instances, skills)
```

See [Architecture](https://docs.polyant.ai/concepts/architecture) for a full technical reference (source: [polyant-ai/docs](https://github.com/polyant-ai/docs)).

## Development Workflow

### Before starting

- For non-trivial features, open an issue first to discuss the approach.
- For bugs, check existing issues before filing a new one.

### Making changes

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Make your changes following the conventions below.
3. Run the checks before pushing:
   ```bash
   npm run typecheck   # must pass with 0 errors
   npm run lint        # must pass with 0 errors
   npm run test:unit   # all tests must pass
   ```

### Commit conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description
```

Valid types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`

Examples:
- `feat(tools): add httpRequest tool with SSRF protection`
- `fix(channels): handle Telegram webhook reconnection`
- `docs(readme): update quick start for Docker setup`

### Sign your work (DCO)

Polyant uses the [Developer Certificate of Origin](https://developercertificate.org/)
for contributions, instead of a Contributor License Agreement.

Every commit must include a `Signed-off-by` line. Sign your commits with:

    git commit -s -m "feat: my change"

This appends a line like:

    Signed-off-by: Your Name <your.email@example.com>

The `-s` flag uses your `git config user.name` and `user.email`. If you forgot
to sign a previous commit, amend it with:

    git commit --amend -s --no-edit

Or rebase to add sign-off to a range of commits:

    git rebase -i --exec "git commit --amend -s --no-edit" main

The DCO check is enforced by GitHub Actions on every pull request. PRs without
sign-off cannot be merged.

### Pull Request process

1. Open a PR against `main` with a clear title (Conventional Commits format).
2. Fill in the PR description: what changes, why, and how to test.
3. CI must pass (lint + typecheck + tests).
4. All commits must be signed off (see DCO section above).
5. At least one maintainer review is required before merge.
6. PRs are squash-merged to keep history clean.

## Code Conventions

- **TypeScript + ESM** — all imports must use `.js` extensions at runtime.
- **Named exports only** — no default exports.
- **File naming** — kebab-case: `user-profile.store.ts`.
- **No `process.env` access** outside `config.ts`.
- **No hardcoded secrets** — use env vars or instance secrets (AES-256-GCM encrypted in DB).
- **Framework-first** — tools, prompt templates, and pipeline logic must be domain-agnostic. Instance-specific behavior lives in per-instance data (prompts, skills, secrets), never in code.

See [`.claude/rules/`](.claude/rules/) for the full coding style rules.

## Adding a New Tool

1. Create `packages/engine/src/agents/tools/my-tool.tool.ts`.
2. Call `registerTool({ name, description, create: (ctx) => ... })` at module level.
3. The tool auto-discovers at boot — no imports to update elsewhere.

## Adding a New Skill

Skills live in the database. Use the management API or admin panel to create them. See [Architecture](https://docs.polyant.ai/concepts/architecture) for the skill system design.

## Running Tests

```bash
npm run test:unit          # fast, no DB required
npm run test:integration   # requires a running PostgreSQL instance
npm run test:functional    # end-to-end scenario tests
```

## Reporting Security Issues

Please **do not** open a public GitHub issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for the responsible-disclosure process and contact details.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).
