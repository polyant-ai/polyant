<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/polyant-logo-horizontal-dark.svg">
    <img alt="Polyant" src=".github/assets/polyant-logo-horizontal-light.svg" width="320">
  </picture>
</p>

# Polyant

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL--v3-blue.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-22-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

🌐 **Website**: [polyant.ai](https://polyant.ai) &nbsp;·&nbsp; 📚 **Docs**: [docs.polyant.ai](https://docs.polyant.ai) &nbsp;·&nbsp; 💬 **GitHub**: [polyant-ai/polyant](https://github.com/polyant-ai/polyant)

---

**Polyant** is an open-source platform for building and deploying AI assistants with long-term memory, multi-channel support, and full per-instance customization. It provides a complete runtime for multi-agent systems with an OpenAI-compatible API, a NestJS engine, and a Next.js admin panel — batteries included.

## Release status

Polyant v1.0.2 is the current stable release, a patch on the first public stable release v1.0.0. Review the [changelog](CHANGELOG.md), the [release notes](docs/releases/v1.0.2.md), and the [GitHub release](https://github.com/polyant-ai/polyant/releases/tag/v1.0.2). In a running admin installation, version and release details are available at `/about`.

> The name comes from Hofstadter's *Gödel, Escher, Bach* — specifically the "Ant Fugue" dialogue and the character of Aunt Hillary, an ant colony understood as the archetype of emergent intelligence: individual agents, each one limited, that produce — by coordinating — a collective intelligent behaviour that exceeds the sum of its parts. It is, literally, the thesis we are pitching: fleets of specialised agents that, when orchestrated, generate performance impossible for any single agent. *Poly-* (classical Greek, "many") makes the key concept explicit: coordinated multiplicity.
>
> *Many agents. One mind.*

## Background

Polyant was conceived in the wake of the **OpenClaw** release. OpenClaw was a watershed moment for the agent ecosystem: it showed, in working code, what a reactive personal AI assistant could feel like and — more importantly — how to build the *harness* around the model: the loop, the tool dispatch, the message lifecycle, the guard rails. For the first time, the engineering pattern behind a serious assistant was readable, hackable, and reproducible outside a vendor-controlled platform.

We took OpenClaw apart, studied its design, and used it as the starting point for an analysis of what a multi-tenant, enterprise-grade evolution of that idea would need. Several technological choices in Polyant echo OpenClaw directly — the tool registry pattern, the supervisor-as-loop architecture, the markdown-driven skill system, the tier abstraction over models — because that vocabulary turned out to be the right one for this class of system.

From that foundation we set out to answer a different question: **what does it take to run this kind of assistant inside an organization?** The answer drove most of the layers you see today and pushed Polyant toward a web-based product rather than a CLI:

- A **multi-instance** model, so a single deployment can serve different assistants — each with its own personality, tools, secrets, and channels — without code branching.
- An **admin panel** as the primary surface, because the people who configure assistants in a company are not always the people who can edit a config file.
- **Per-instance encryption** of every secret (AES-256-GCM), so credentials for one assistant cannot leak into another tenant's blast radius.
- A **proactive Room engine** alongside the reactive chat loop, because real assistants do not only answer — they observe events and act.
- An **OpenAI-compatible API** as the default integration surface, so any client (Open WebUI, custom apps, scripts) can talk to any instance with zero adaptation.

Polyant is, in short, what happens when you take the architectural lessons of OpenClaw, hold them up against the requirements of building assistants that real teams can deploy, govern, and trust — and then ship the result as open source.

## Features

- **Supervisor Agent** — Central orchestrator with tool use, up to 15 reasoning steps per request (Vercel AI SDK)
- **Long-term Memory** — Automatic fact extraction via LLM; hybrid search with pgvector cosine similarity + PostgreSQL FTS fused via Reciprocal Rank Fusion
- **Multi-channel** — Telegram, Slack, WhatsApp, and an OpenAI-compatible HTTP API (with file attachment support)
- **Provider-agnostic** — Switch between OpenAI, Anthropic, Amazon Bedrock, and Nebius Token Factory per instance from the admin panel; the embedding provider is chosen independently of the chat provider. A tier abstraction (`fast | standard | heavy`) decouples code from model names, and a model catalog carries per-model pricing, vision, reasoning, and prompt-caching capabilities
- **Tools & Plugins** — Author a tool as `export default defineTool(...)` from `@polyant-ai/plugin-sdk`; the engine loader collects it at boot with no wiring. Tools live in-engine or in external **plugin** repos loaded via `PLUGIN_DIRS` — see [Plugins & the SDK](#plugins--the-sdk)
- **Skill System** — Markdown-based skill definitions stored in the database; per-instance encrypted env vars for skills that need API keys
- **Multi-instance** — Independent configuration of prompts, skills, tool availability, and identity per instance; instances exposed as selectable "models" via the OpenAI-compatible API
- **Per-instance Secrets** — API keys, channel config, and LangSmith settings stored AES-256-GCM encrypted per instance
- **Admin Panel** — Next.js 16 frontend for managing instances, conversations, memories, skills, tools, channels, and analytics
- **Event-driven Room** — Proactive agent workspace that processes webhook events on a 30-second tick and can push outbound messages
- **Conversation Tracking** — Full message history with summaries and full-text search in PostgreSQL
- **Analytics** — Token usage, cost tracking, and pipeline latency per instance
- **Cost Monitoring** — Every LLM call logged with token counts and estimated USD cost
- **File Attachments** — Photos and PDFs from WhatsApp/Telegram stored in S3, passed as multimodal content to the LLM
- **Voice Messages** — Inbound audio transcribed per instance via OpenAI Whisper, Amazon Transcribe, or Deepgram — or turned off explicitly
- **Knowledge Base** — Per-instance documents chunked and retrieved with pgvector, editable from the panel and portable as a JSON bundle
- **Lifecycle Hooks** — Typed code hooks at four fixed pipeline points that can inject context, halt a turn and answer, or replace the generated reply
- **Scheduled Tasks** — Cron-style prompts an instance runs on its own, with a per-run log
- **Agent-to-Agent** — An instance can call another instance in-process as an `ask_<slug>` tool, bounded to one hop
- **RBAC & Tenancy** — `Organization → Workspace → Instance` with four system roles (Owner / Admin / Member / Viewer) over a `resource:action` permission matrix. In v1.0.x the guard ships in **shadow mode**: decisions are resolved and logged but never denied until you set `AUTHZ_ENFORCE=true`
- **GDPR Opt-out** — Deterministic STOP/START keyword gate per contact, enforced in code rather than by the model, blocking inbound and proactive outbound alike
- **Export & Import** — A full instance configuration (prompts, skills, tools, channels, hooks, Room, tasks) travels as a JSON bundle; secrets are never exported

## Documentation

The full documentation lives at **[docs.polyant.ai](https://docs.polyant.ai)** (source: [polyant-ai/docs](https://github.com/polyant-ai/docs)).

### Get started
- **[Getting Started](https://docs.polyant.ai/getting-started/quickstart)** — build your first agent in 10 minutes
- **[Channels Setup](https://docs.polyant.ai/getting-started/connect-a-channel)** — Telegram, Slack, WhatsApp recipes
- **[Examples](examples/README.md)** — minimal instance, skill, and tool templates

### Operate
- **[Deployment](https://docs.polyant.ai/operations/deployment)** — Docker Compose, Render, Fly.io, Kubernetes

### Understand
- **[Architecture](https://docs.polyant.ai/concepts/architecture)** — full technical deep dive
- **[Glossary](https://docs.polyant.ai/concepts/glossary)** — Instance, Tier, Room, Skill, Tool explained

## Quick Start

### Prerequisites

- [Node.js 22+](https://nodejs.org)
- [Docker & Docker Compose](https://docs.docker.com/get-docker/)

### 1. Clone and install

```bash
git clone https://github.com/polyant-ai/polyant.git
cd polyant
npm install
```

### 2. Start infrastructure

```bash
docker compose up -d
```

Starts PostgreSQL 16 with pgvector on port 5432.

### 3. Configure environment

```bash
cp .env.example .env
```

Generate the three required secrets and paste each into `.env`:

```bash
openssl rand -hex 32   # → ENCRYPTION_KEY
openssl rand -hex 32   # → AUTH_SECRET
openssl rand -hex 32   # → AUTH_INTERNAL_SECRET
```

Set an initial admin account (used for the first sign-in) in `.env`:

```bash
INITIAL_ADMIN_EMAIL=admin@example.com
INITIAL_ADMIN_PASSWORD=choose-a-strong-password
```

The admin panel (Next.js) does not read the root `.env`. Mirror the values
into `packages/web/.env.local`:

```bash
# packages/web/.env.local
AUTH_SECRET=<same value as .env>
AUTH_INTERNAL_SECRET=<same value as .env>
AUTH_TRUST_HOST=true
DATABASE_URL=postgresql://polyant:changeme@localhost:5432/polyant
NEXT_PUBLIC_API_URL=http://localhost:4000
INTERNAL_ENGINE_URL=http://localhost:4000
```

### 4. Run migrations and start

```bash
npm run db:migrate   # create all tables
npm run dev          # engine on :4000
npm run dev:web      # admin panel on :3000 (separate terminal)
```

Open `http://localhost:3000`, sign in with the admin credentials from step 3, create an instance, and configure your AI provider keys in the Settings tab.

## Architecture

```
┌──────────────────────────────────────────────┐
│         packages/web  (Next.js 16)           │
│     Admin Panel — instance management        │
└─────────────────┬────────────────────────────┘
                  │ REST API + cookie auth
┌─────────────────┴────────────────────────────┐
│        packages/engine  (NestJS 11)          │
├──────────────────────────────────────────────┤
│  HTTP Server     OpenAI-compatible API       │
│  Channel Layer   Telegram · Slack · WhatsApp │
│  Agent Layer     Supervisor + Tool Registry  │
│  Memory Layer    pgvector + PG FTS + LLM     │
│  AI Gateway      Tier abstraction + logging  │
│  Room Engine     Event-driven proactive loop │
│  Crypto Layer    AES-256-GCM encryption      │
│  Data Layer      PostgreSQL 16 (Drizzle ORM) │
└──────────────────────────────────────────────┘
```

See [Architecture](https://docs.polyant.ai/concepts/architecture) for the full technical reference.

## Project Structure

```
polyant/
├── packages/
│   ├── engine/               # @polyant/engine — NestJS AI runtime + API
│   │   └── src/
│   │       ├── agents/       # Supervisor, tool registry, sub-agent delegation
│   │       ├── ai-gateway/   # Provider-agnostic LLM abstraction (tier-based)
│   │       ├── channels/     # Telegram, Slack, WhatsApp adapters
│   │       ├── memory/       # pgvector embeddings + hybrid search
│   │       ├── knowledge/    # Per-instance document store + retrieval
│   │       ├── hooks/        # Conversation lifecycle hooks
│   │       ├── room/         # Event-driven proactive agent workspace
│   │       ├── instances/    # Instance CRUD, secrets, config resolver
│   │       ├── skills/       # Global skill library CRUD
│   │       ├── authz/        # Roles, permissions, tenancy scoping
│   │       └── server/       # NestJS controllers (REST + OpenAI-compat)
│   └── web/                  # @polyant/web — Next.js admin panel
│       └── src/app/
│           ├── (auth)/       # Sign-in (email + password, optional Google OAuth)
│           └── (admin)/      # Protected admin routes
├── examples/                 # Minimal working examples (instances, skills)
└── docker-compose.yml        # PostgreSQL + pgvector
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Instance** | A named assistant configuration with independent prompts, skills, tools, and secrets |
| **Tier abstraction** | Code requests `fast \| standard \| heavy`; model mapping lives in `ai-gateway/config.ts` |
| **Tool registry** | Tools are `export default defineTool(...)` files collected at boot by the engine loader — no hardcoded imports. See [Plugins & the SDK](#plugins--the-sdk) |
| **Plugins** | External git repos of tools loaded via `PLUGIN_DIRS` / `src/plugins/*`, authored against `@polyant-ai/plugin-sdk` |
| **Skill system** | Markdown skill definitions in DB; encrypted per-instance env vars for API keys |
| **Room** | Event-driven workspace that runs a ReAct cycle on webhook-triggered events |
| **Fire-and-forget** | Post-response tasks (memory extraction, summary) run async without blocking the user |

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start engine with hot reload (tsx watch, port 4000) |
| `npm run dev:web` | Start Next.js admin panel (port 3000) |
| `npm run build` | Build all packages |
| `npm start` | Run engine from compiled output |
| `npm run db:generate` | Generate Drizzle migrations from schema |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Open Drizzle Studio GUI |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only (no DB required) |
| `npm run test:integration` | Integration tests (requires PostgreSQL) |
| `npm run lint` | ESLint all packages |
| `npm run typecheck` | TypeScript check all packages |

## Channels

| Channel | Protocol | Notes |
|---------|----------|-------|
| **HTTP API** | OpenAI-compatible (`/v1/chat/completions`) | Instances appear as selectable models |
| **Telegram** | Long polling (grammY) | Text, photos, document attachments |
| **Slack** | Socket Mode (@slack/bolt) | Per-instance configuration |
| **WhatsApp** | Webhook via Twilio (Auth Token or API Key) | Text and media attachments |

All channel configs are stored encrypted per-instance. Adapters start/stop dynamically without a restart.

## Plugins & the SDK

Polyant is **framework-first** — it ships generic tools, and domain-specific ones (a CRM's booking flow, a billing lookup) live in **plugins**: external git repos of tool files the engine loads at boot. Both the engine's own tools and plugin tools use one small, stateless contract package: **[`@polyant-ai/plugin-sdk`](https://github.com/polyant-ai/polyant-sdk)** (referenced as a public git dependency, `git+https://github.com/polyant-ai/polyant-sdk.git#v1.5.0`).

### Writing a tool

A tool file lives at `tools/<name>.tool.ts` and **default-exports** a `defineTool(...)`:

```ts
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "bookAppointment",              // loads as "<namespace>:bookAppointment" in a plugin
  description: "Book an appointment in the CRM.",
  category: "plugin",
  requiredSecrets: [{ key: "crm_api_key", type: "text" }],
  parameters: z.object({                // STATIC schema — must NOT depend on ctx
    patientId: z.string(),
    date: z.string().describe("ISO 8601"),
  }),
  execute: async (input, ctx) => {      // ctx: instanceId, secrets, audit, state, apiKeys…
    const key = ctx.secrets?.crm_api_key;
    // …call your API; do runtime validation here and return { error } rather than throwing…
    return { status: "booked", id: "..." };
  },
});
```

`defineTool` serializes the static Zod `parameters` to **JSON Schema at module load, in your plugin's own realm**. The engine only ever receives **data** (`inputSchema`) plus your `execute` function — never a live Zod object. That data boundary is what lets the engine and each plugin resolve their own copies of the SDK (and `zod`, `ai`, …) without breakage.

Schema rules (OpenAI strict-mode compatible): use `.nullable()` not `.optional()`/`.default()`; no `.transform()`/`.refine()`/`.preprocess()` in `parameters` (move that into `execute`); avoid `.url()`/`.email()`/`.uuid()`/`.datetime()` formats. A boot-time test (`strict-mode.test.ts`) enforces this.

### `plugin.json` (at the plugin repo root)

```json
{ "name": "acme-tools", "version": "1.0.0", "engine": ">=0.1.0", "toolsDir": "tools", "namespace": "acme" }
```

`namespace` prefixes every tool name (`acme:bookAppointment`); defaults to `name`. A plugin whose `engine` range excludes the running engine version is **skipped with a warning** — the deployment keeps running.

### Loading a plugin

The loader scans two sources (env wins de-dup):

1. **`PLUGIN_DIRS`** — comma-separated absolute paths, e.g. `PLUGIN_DIRS=/abs/path/to/my-plugin npm run dev`. Point it at a plugin repo that has its **own** `node_modules` (`npm install` there, with the SDK as a git dep).
2. **Convention dir** — every subdir of `packages/engine/src/plugins/*` that has a `plugin.json` (gitignored runtime drop dir). A **real dir here** resolves the monorepo's `node_modules` and `tsx watch` hot-reloads it.

**Do not symlink a plugin** — Node/`tsx` resolve a file's imports from its real on-disk location, so a symlink points back at the external repo and can't find the monorepo deps.

Full authoring reference: **[docs/plugins.md](docs/plugins.md)**, the SDK's own **[README](https://github.com/polyant-ai/polyant-sdk#readme)**, and the design record at `docs/superpowers/specs/2026-07-02-serialized-plugin-mechanism.md`.

## Stability and compatibility

Semantic Versioning applies to the documented OpenAI-compatible API, Plugin SDK and manifest, and documented configuration and migration behavior. Internal engine modules and the admin UI are not public SemVer surfaces.

To upgrade an existing development installation, back up PostgreSQL, then run:

```bash
npm ci
npm run db:migrate
npm run build
```

Restart the services, then smoke-test sign-in and a representative chat.

## Roadmap

See [GitHub Issues](https://github.com/polyant-ai/polyant/issues) and [Discussions](https://github.com/polyant-ai/polyant/discussions) for the live list of planned features and open requests. The items below describe the major directions we want Polyant to grow in, grouped by intent.

### Architectural directions

- **Multi-tenancy** — the *Organization → Workspace → Instance* hierarchy, its RBAC role/permission model, and the `PermissionGuard` are implemented ("Project" was renamed **Workspace**). What is still missing is the tenant *experience*: enforcement is opt-in (`AUTHZ_ENFORCE`, shadow mode by default), a single default organization and workspace are seeded with no CRUD for either, there is no workspace switcher, and there is no email-invitation flow — an administrator creates the user and then assigns a role, which works but is two manual steps. Custom per-organization roles are out of scope for the OSS edition.
- **More embedding providers** — embeddings go through their own gateway (`embeddings-gateway/`) and the provider is chosen per instance, independently of the chat provider, but the choice is currently OpenAI or Amazon Bedrock Titan. We want the same breadth the chat layer has: Voyage, Cohere, and local models (Ollama, a self-hosted bge / nomic). Note that switching an instance's embedder is destructive by design — vector spaces are not convertible, so memories and the knowledge base are wiped and must be re-imported.
- **Sandboxed tool execution** — high-impact tools (anything that runs git, executes shell, writes files, or talks to a customer's infrastructure) should not run inside the engine process. We want to push these into an external sandbox (firecracker / gVisor / a remote isolate-style runner) with a tight contract: tool input → sandbox → tool output. The current trade-offs (e.g. the `gitCloneRepo` token written under `.git/polyant-token` while the workspace exists) become non-issues once execution is moved off-host.
- **Evaluation suite** — simulation-based regression testing for assistants: digital twins, scenario libraries, golden conversations, and a CI integration so that changing a prompt or skill produces a measurable delta.

### Channels & UX

- **Voice channel** — bidirectional voice as a first-class adapter alongside Telegram / Slack / WhatsApp. Inbound audio is already transcribed per instance (Whisper / Amazon Transcribe / Deepgram); TTS and a realtime transport are the missing half.
- **Web widget** — embeddable chat surface that talks to an instance directly via the OpenAI-compatible API.
- **Channel-level analytics** — per-channel cost, latency, error rate (today analytics are aggregated per instance).

### Developer experience

- **Skill version diffing** — the admin panel has a skill editor, but comparing two versions of a skill still means reading both by hand.
- **Tool scaffolding CLI** — `npm run create-tool <name>` to drop a `*.tool.ts` skeleton wired to the registry.
- **Drizzle migration ergonomics** — the current ESM workaround for `drizzle-kit generate` (running it via `npx tsx ../../node_modules/drizzle-kit/bin.cjs generate`) and the lack of snapshot files force migrations to be hand-edited. We want to either fix the toolchain interaction or migrate the schema-diff workflow to an alternative that plays nicely with ESM monorepos.

## Known Open Issues

These are deliberate trade-offs, deferred decisions, or rough edges that ship with Polyant today. They are listed here so that contributors and adopters know what they are picking up — and so that we can collect help and PRs against a shared list rather than a private wiki.

### Architecture & coupling

- **Embeddings have only two providers** — the embedder is resolved per instance in `embeddings-gateway/provider-resolver.ts` and is independent of the chat provider, but the only choices are OpenAI and Amazon Bedrock Titan. An instance on Anthropic still needs credentials for one of those two if memory or knowledge is enabled, and changing the embedder later wipes memories and the knowledge base (vector spaces are not convertible) — export the knowledge base first.
- **Critical tools run in-process** — `gitCloneRepo`, file system access, and any future shell-style tools execute in the engine's own runtime. The current safeguards (per-conversation workspace, ephemeral credentials at `.git/polyant-token` mode 0600, automatic cleanup) keep the blast radius small but do not isolate CPU, network, or filesystem at OS level. Moving tool execution to an external sandbox is on the roadmap.
- **Untyped Auth.js adapter wiring** — `packages/web/src/lib/auth.ts` casts the Drizzle adapter and its four table arguments through `as any` (5 sites). Both packages now pin the same `drizzle-orm`, so the original reason no longer applies; the casts survive because `@auth/drizzle-adapter` expects its own schema shape. Typing the mapping properly would remove them.
- **`workspaces/` is an overloaded name** — the filesystem `workspaces/<instanceId>/conversations/<convId>/` tree is now *only* a per-conversation tool sandbox (knowledge moved fully into PostgreSQL), while `workspaces` is also the RBAC tenancy level between organization and instance, and npm calls the two packages workspaces too. Three unrelated meanings, one word — renaming the filesystem root (e.g. to `sandboxes/`) is the cheap fix.

### Robustness

- **Fire-and-forget post-processing swallows failures** — message persistence, summary updates, and memory extraction run async after the user reply (`pipeline.ts`). On error they currently log via `console.error` and move on. There is no retry, no dead-letter queue, and no surfacing in the admin panel — a failed memory write is invisible to operators.
- **Structured logging is incomplete** — a level-gated logger factory (`utils/create-logger.ts`) is in place and daily log files are written, but roughly twenty engine modules still call `console.log` / `console.error` directly. The goal is one structured logger across engine and web with consistent fields (instanceId, conversationId, requestId).
- **Webhook backlog drops events silently** — `POST /webhooks/:token` always returns `200 OK` and drops events when the per-instance backlog cap (100) is reached. There is no operator-facing signal. A bounded queue with overflow alerting is the planned fix.
- **Rate limiting is per-IP, not per-tenant** — a global throttler (30 requests/minute by default, with tighter per-route limits on sign-in, knowledge import, and the OpenAI-compatible endpoint) applies to every route, but the bucket is keyed by IP address. Two tenants behind one egress IP share a budget, and one API key cannot be throttled independently of another.

### Code quality & deferred design

- **WhatsApp template fallback is a stub in OSS** — `channels/adapters/whatsapp/stub-templates.ts` ships with an empty `STUB_TEMPLATES` map. Operators using WhatsApp's strict 24-hour session window must populate it with their own approved templates; otherwise the adapter falls back to a compact summary string.
- **Files exceeding the 400-line house rule** — a few files in `packages/web/src/` still bundle multiple responsibilities and are due for a split.

### Documentation gaps

- Trade-offs around the `gitCloneRepo` credential lifecycle (token at rest while the workspace exists) are documented in `CLAUDE.md` but should be surfaced on [docs.polyant.ai](https://docs.polyant.ai) as well, since they affect deployment posture.
- The RBAC guard defaults to shadow mode (`AUTHZ_ENFORCE` unset), which is not stated in the deployment documentation — an operator can reasonably believe roles are being enforced when they are not.

If you would like to take on any of the items above, please open an issue first so we can scope it together — most of these decisions involve trade-offs we are happy to discuss in the open.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, coding conventions, and the PR process.

## Security

For vulnerability reports, see [SECURITY.md](SECURITY.md) — please do not file public issues for security bugs.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | npm workspaces |
| Language | TypeScript / Node.js (ESM) |
| Agent Framework | Vercel AI SDK v6 |
| Engine Server | NestJS 11 |
| Admin Panel | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui |
| Database | PostgreSQL 16 + pgvector (Drizzle ORM) |
| Memory | pgvector cosine similarity + PostgreSQL FTS (RRF fusion) |
| Encryption | AES-256-GCM (Node.js crypto) |
| Auth | Auth.js v5 (email + password, optional Google OAuth, JWT/JWE) |
| Tracing | LangSmith |
| Infrastructure | Docker Compose |

## License

Polyant is licensed under the [GNU Affero General Public License v3.0](LICENSE).
