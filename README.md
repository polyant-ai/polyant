<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/polyant-logo-horizontal-dark.svg">
    <img alt="Polyant" src=".github/assets/polyant-logo-horizontal-light.svg" width="320">
  </picture>
</p>

# Polyant

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL--v3-blue.svg)](LICENSE)
[![Node.js 22](https://img.shields.io/badge/node-22-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

🌐 **Website**: [polyant.ai](https://polyant.ai) &nbsp;·&nbsp; 📚 **Docs**: [docs.polyant.ai](https://docs.polyant.ai) &nbsp;·&nbsp; 💬 **GitHub**: [polyant-ai/polyant](https://github.com/polyant-ai/polyant)

---

**Polyant** is an open-source platform for building and deploying AI assistants with long-term memory, multi-channel support, and full per-instance customization. It provides a complete runtime for multi-agent systems with an OpenAI-compatible API, a NestJS engine, and a Next.js admin panel — batteries included.

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
- **Provider-agnostic** — Switch between OpenAI and Anthropic per-instance via the admin panel; tier abstraction (`fast | standard | heavy`) decouples code from model names
- **Tools & Plugins** — Author a tool as `export default defineTool(...)` from `@polyant-ai/plugin-sdk`; the engine loader collects it at boot with no wiring. Tools live in-engine or in external **plugin** repos loaded via `PLUGIN_DIRS` — see [Plugins & the SDK](#plugins--the-sdk)
- **Skill System** — Markdown-based skill definitions stored in the database; per-instance encrypted env vars for skills that need API keys
- **Multi-instance** — Independent configuration of prompts, skills, tool availability, and identity per instance; instances exposed as selectable "models" via the OpenAI-compatible API
- **Per-instance Secrets** — API keys, channel config, and LangSmith settings stored AES-256-GCM encrypted per instance
- **Admin Panel** — Next.js 15 frontend for managing instances, conversations, memories, skills, tools, channels, and analytics
- **Event-driven Room** — Proactive agent workspace that processes webhook events on a 30-second tick and can push outbound messages
- **Conversation Tracking** — Full message history with summaries and full-text search in PostgreSQL
- **Analytics** — Token usage, cost tracking, and pipeline latency per instance
- **Cost Monitoring** — Every LLM call logged with token counts and estimated USD cost
- **File Attachments** — Photos and PDFs from WhatsApp/Telegram stored in S3, passed as multimodal content to the LLM

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
npm run dev:web      # admin panel on :3001 (separate terminal)
```

Open `http://localhost:3001`, sign in with the admin credentials from step 3, create an instance, and configure your AI provider keys in the Settings tab.

## Architecture

```
┌──────────────────────────────────────────────┐
│         packages/web  (Next.js 15)           │
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
│   │       ├── agents/       # Supervisor, tools registry, sub-agent types
│   │       ├── ai-gateway/   # Provider-agnostic LLM abstraction (tier-based)
│   │       ├── channels/     # Telegram, Slack, WhatsApp adapters
│   │       ├── memory/       # pgvector embeddings + hybrid search
│   │       ├── room/         # Event-driven proactive agent workspace
│   │       ├── instances/    # Instance CRUD, secrets, config resolver
│   │       ├── skills/       # Global skill library CRUD
│   │       └── server/       # NestJS controllers (REST + OpenAI-compat)
│   └── web/                  # @polyant/web — Next.js admin panel
│       └── src/app/
│           ├── (auth)/       # Google OAuth login
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
| `npm run dev:web` | Start Next.js admin panel (port 3001) |
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
| **WhatsApp** | Webhook via Twilio | Text and media attachments |

All channel configs are stored encrypted per-instance. Adapters start/stop dynamically without a restart.

## Plugins & the SDK

Polyant is **framework-first** — it ships generic tools, and domain-specific ones (a CRM's booking flow, a billing lookup) live in **plugins**: external git repos of tool files the engine loads at boot. Both the engine's own tools and plugin tools use one small, stateless contract package: **[`@polyant-ai/plugin-sdk`](https://github.com/polyant-ai/polyant-sdk)** (referenced as a public git dependency, `git+https://github.com/polyant-ai/polyant-sdk.git#v1.0.0`).

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
{ "name": "innovasemplice", "version": "1.0.0", "engine": ">=0.1.0", "toolsDir": "tools", "namespace": "innova" }
```

`namespace` prefixes every tool name (`innova:bookAppointment`); defaults to `name`. A plugin whose `engine` range excludes the running engine version is **skipped with a warning** — the deployment keeps running.

### Loading a plugin

The loader scans two sources (env wins de-dup):

1. **`PLUGIN_DIRS`** — comma-separated absolute paths, e.g. `PLUGIN_DIRS=/abs/path/to/my-plugin npm run dev`. Point it at a plugin repo that has its **own** `node_modules` (`npm install` there, with the SDK as a git dep).
2. **Convention dir** — every subdir of `packages/engine/src/plugins/*` that has a `plugin.json` (gitignored runtime drop dir). A **real dir here** resolves the monorepo's `node_modules` and `tsx watch` hot-reloads it.

**Do not symlink a plugin** — Node/`tsx` resolve a file's imports from its real on-disk location, so a symlink points back at the external repo and can't find the monorepo deps.

Full authoring reference: **[docs/plugins.md](docs/plugins.md)**, the SDK's own **[README](https://github.com/polyant-ai/polyant-sdk#readme)**, and the design record at `docs/superpowers/specs/2026-07-02-serialized-plugin-mechanism.md`.

## Roadmap

See [GitHub Issues](https://github.com/polyant-ai/polyant/issues) and [Discussions](https://github.com/polyant-ai/polyant/discussions) for the live list of planned features and open requests. The items below describe the major directions we want Polyant to grow in, grouped by intent.

### Architectural directions

- **Multi-tenancy** — formalize the *Organization → Project → Instance* hierarchy already sketched in the auth module (Phase 2). Adds invitation-based memberships, configurable RBAC, and tenant-scoped URLs (`/organizations/{org}/projects/{project}/instances/{slug}/...`). Schema design (`organizations`, `projects`, `organization_memberships`, `roles`, `invitations`) is documented; not yet implemented.
- **Pluggable memory backend** — today the memory layer is hard-wired to OpenAI for embeddings (the per-instance `openai_api_key` secret is required regardless of the assistant's chat provider, because Anthropic has no embedding API). The roadmap is to introduce a `MemoryProvider` abstraction so that embeddings can come from Voyage, Cohere, local models (e.g. via Ollama / a locally hosted bge / nomic), or a self-hosted gateway — just like the chat layer already is provider-agnostic via the AI Gateway tiers.
- **Sandboxed tool execution** — high-impact tools (anything that runs git, executes shell, writes files, or talks to a customer's infrastructure) should not run inside the engine process. We want to push these into an external sandbox (firecracker / gVisor / a remote isolate-style runner) with a tight contract: tool input → sandbox → tool output. The current trade-offs (e.g. the `gitCloneRepo` token written under `.git/polyant-token` while the workspace exists) become non-issues once execution is moved off-host.
- **Evaluation suite** — simulation-based regression testing for assistants: digital twins, scenario libraries, golden conversations, and a CI integration so that changing a prompt or skill produces a measurable delta.

### Channels & UX

- **Voice channel** — bidirectional voice as a first-class adapter alongside Telegram / Slack / WhatsApp.
- **Web widget** — embeddable chat surface that talks to an instance directly via the OpenAI-compatible API.
- **Channel-level analytics** — per-channel cost, latency, error rate (today analytics are aggregated per instance).

### Developer experience

- **Self-service skill editor in the admin panel** — today skills are edited as markdown via API; an in-product editor with version diffing is on the list.
- **Tool scaffolding CLI** — `npm run create-tool <name>` to drop a `*.tool.ts` skeleton wired to the registry.
- **Drizzle migration ergonomics** — the current ESM workaround for `drizzle-kit generate` (running it via `npx tsx ../../node_modules/drizzle-kit/bin.cjs generate`) and the lack of snapshot files force migrations to be hand-edited. We want to either fix the toolchain interaction or migrate the schema-diff workflow to an alternative that plays nicely with ESM monorepos.

## Known Open Issues

These are deliberate trade-offs, deferred decisions, or rough edges that ship with Polyant today. They are listed here so that contributors and adopters know what they are picking up — and so that we can collect help and PRs against a shared list rather than a private wiki.

### Architecture & coupling

- **Memory is locked to OpenAI** — `packages/engine/src/memory/embedder.ts` calls the OpenAI embeddings endpoint directly. An instance configured to use Anthropic for the chat tier still needs an `openai_api_key` secret if memory is enabled. Replacing this with a `MemoryProvider` interface is a high-priority item on the roadmap above.
- **Critical tools run in-process** — `gitCloneRepo`, file system access, and any future shell-style tools execute in the engine's own runtime. The current safeguards (per-conversation workspace, ephemeral credentials at `.git/polyant-token` mode 0600, automatic cleanup) keep the blast radius small but do not isolate CPU, network, or filesystem at OS level. Moving tool execution to an external sandbox is on the roadmap.
- **Drizzle version mismatch between packages** — `packages/web/src/lib/auth.ts` casts the Drizzle adapter through `as any` (4 sites) because `packages/engine` and `packages/web` pin different `drizzle-orm` versions. Works today, but it's brittle — a single version pin across the workspace is the proper fix.
- **`workspaces/` directory is a leftover** — the filesystem `workspaces/<instanceId>/` tree is documented as legacy and only used for knowledge-file sync. The intent is to either fold knowledge into the database (consistent with the rest of the configuration model) or to formalize `workspaces/` as a sandbox root.

### Robustness

- **Fire-and-forget post-processing swallows failures** — message persistence, summary updates, and memory extraction run async after the user reply (`pipeline.ts`). On error they currently log via `console.error` and move on. There is no retry, no dead-letter queue, and no surfacing in the admin panel — a failed memory write is invisible to operators.
- **Structured logging is incomplete** — several boot/runtime paths still use `console.log` / `console.error` (the project's own coding rules forbid this in production code). We want a single structured logger across engine and web with consistent fields (instanceId, conversationId, requestId).
- **Webhook backlog drops events silently** — `POST /webhooks/:token` always returns `200 OK` and drops events when the per-instance backlog cap (100) is reached. There is no operator-facing signal. A bounded queue with overflow alerting is the planned fix.
- **Rate limiting is uneven** — the OpenAI-compatible endpoint is throttled, but `/memories` and several management endpoints have no per-tenant rate limits. Memory-write spam from a misbehaving client is not prevented today.
- **Activity-log compaction is described but not scheduled** — Room activity is documented as auto-compacted (`7d daily → weekly → monthly`) but no scheduled job actually runs the compaction step yet. Tables grow until manually pruned.

### Code quality & deferred design

- **`SubAgentDefinition` is unused** — the type is defined in `packages/engine/src/agents/sub-agents/types.ts` and a place-holder for specialized sub-agents (researcher, analyst, …). Today `spawnTask` creates ad-hoc agents that don't reference it. Either wire it up or delete the type until it's needed.
- **WhatsApp template fallback is a stub in OSS** — `channels/adapters/whatsapp/stub-templates.ts` ships with an empty `STUB_TEMPLATES` map. Operators using WhatsApp's strict 24-hour session window must populate it with their own approved templates; otherwise the adapter falls back to a compact summary string.
- **Files exceeding the 400-line house rule** — a few files in `packages/web/src/` still bundle multiple responsibilities and are due for a split.

### Documentation gaps

- The "Phase 2 — Multi-Tenancy" section of `CLAUDE.md` describes a hierarchy that does not exist in the schema yet; this is a roadmap document, not a description of current behavior.
- Trade-offs around the `gitCloneRepo` credential lifecycle (token at rest while the workspace exists) are documented in `CLAUDE.md` but should be surfaced on [docs.polyant.ai](https://docs.polyant.ai) as well, since they affect deployment posture.

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
| Agent Framework | Vercel AI SDK v4 |
| Engine Server | NestJS 11 |
| Admin Panel | Next.js 15, React 19, Tailwind CSS 4, shadcn/ui |
| Database | PostgreSQL 16 + pgvector (Drizzle ORM) |
| Memory | pgvector cosine similarity + PostgreSQL FTS (RRF fusion) |
| Encryption | AES-256-GCM (Node.js crypto) |
| Auth | Auth.js v5 (Google OAuth, JWT/JWE) |
| Tracing | LangSmith |
| Infrastructure | Docker Compose |

## License

Polyant is licensed under the [GNU Affero General Public License v3.0](LICENSE).
