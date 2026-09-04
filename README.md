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

Polyant v1.1.0 is the current stable release. Review the [changelog](CHANGELOG.md), the [release notes](docs/releases/v1.1.0.md), and the [GitHub release](https://github.com/polyant-ai/polyant/releases/tag/v1.1.0). Upgrading from 1.0.0 needs operator action — read the [upgrade guide](docs/UPGRADING.md) first. In a running admin installation, version and release details are available at `/about`.

> The name comes from Hofstadter's *Gödel, Escher, Bach* — specifically the "Ant Fugue" dialogue and the character of Aunt Hillary, an ant colony understood as the archetype of emergent intelligence: individual agents, each one limited, that produce — by coordinating — a collective intelligent behaviour that exceeds the sum of its parts. It is, literally, the thesis we are pitching: fleets of specialised agents that, when orchestrated, generate performance impossible for any single agent. *Poly-* (classical Greek, "many") makes the key concept explicit: coordinated multiplicity.
>
> *Many agents. One mind.*

## Background

Polyant grew out of taking **OpenClaw** apart and asking a different question: what does it
take to run that kind of assistant *inside an organization*? The answer produced a
multi-instance model, an admin panel as the primary surface, per-instance secret encryption,
a proactive Room engine next to the reactive chat loop, and an OpenAI-compatible API as the
default integration surface.

Read the long version in **[Why Polyant](docs/why-polyant.md)**.

## Features

- **Supervisor Agent** — Central orchestrator with tool use, up to 15 reasoning steps per request (Vercel AI SDK)
- **Long-term Memory** — Automatic fact extraction via LLM; hybrid search with pgvector cosine similarity + PostgreSQL FTS fused via Reciprocal Rank Fusion
- **Multi-channel** — Telegram, Slack, WhatsApp, and an OpenAI-compatible HTTP API (with file attachment support)
- **Provider-agnostic** — Switch between OpenAI, Anthropic, Amazon Bedrock, and Nebius Token Factory per agent from the admin panel; the embedding provider is chosen independently of the chat provider. A tier abstraction (`fast | standard | heavy`) decouples code from model names, and a model catalog carries per-model pricing, vision, reasoning, and prompt-caching capabilities
- **Tools & Plugins** — Author a tool as `export default defineTool(...)` from `@polyant-ai/plugin-sdk`; the engine loader collects it at boot with no wiring. Tools live in-engine or in external **plugin** repos loaded via `PLUGIN_DIRS` — see [Plugins & the SDK](#plugins--the-sdk)
- **MCP Client** — Equip an agent with tools from external **Model Context Protocol** servers, configured per agent. Three auth modes (`none` for public or network-isolated servers, `static` for a bearer token or custom header, `oauth` for OAuth 2.1 including Dynamic Client Registration); credentials are stored AES-256-GCM encrypted and never returned by the API. A slow or dead server is skipped for the turn rather than stalling it (`MCP_CONNECT_TIMEOUT_MS`)
- **A2A Server** — Expose an agent to other agents over the **Agent2Agent** protocol: an Agent Card at `GET /a2a/:slug/.well-known/agent-card.json` and JSON-RPC at `POST /a2a/:slug/jsonrpc`. Opt-in per agent (`a2a_enabled`, default off) and authenticated with the agent's own API key
- **Skill System** — Markdown-based skill definitions stored in the database; per-instance encrypted env vars for skills that need API keys
- **Multi-instance** — Independent configuration of prompts, skills, tool availability, and identity per instance; instances exposed as selectable "models" via the OpenAI-compatible API
- **Per-instance Secrets** — API keys, channel config, and LangSmith settings stored AES-256-GCM encrypted per instance
- **RBAC** — `Organization → Workspace → Agent` tenancy with four system roles (Owner / Admin / Member / Viewer) and a `resource:action` permission matrix, enforced unconditionally (no shadow mode, no opt-out); membership is granted deliberately by an administrator, never by signing in
- **Admin Panel** — Next.js 16 frontend for managing instances, conversations, memories, skills, tools, channels, and analytics
- **Event-driven Room** — Proactive agent workspace that processes webhook events on a 30-second tick and can push outbound messages
- **Conversation Tracking** — Full message history with summaries and full-text search in PostgreSQL
- **Analytics** — Token usage, cost tracking, and pipeline latency per instance
- **Cost Monitoring** — Every LLM call logged with token counts and estimated USD cost
- **File Attachments** — Photos and PDFs from WhatsApp/Telegram stored in S3, passed as multimodal content to the LLM
- **Voice Messages** — Inbound audio transcribed per agent via OpenAI Whisper, Amazon Transcribe, or Deepgram — or turned off explicitly
- **Knowledge Base** — Per-agent documents chunked and retrieved with pgvector, editable from the panel and portable as a JSON bundle
- **Lifecycle Hooks** — Typed code hooks at four fixed pipeline points that can inject context, halt a turn and answer, or replace the generated reply
- **Scheduled Tasks** — Cron-style prompts an agent runs on its own, with a per-run log
- **Agent-to-Agent (in-process)** — Beyond the A2A protocol above, an agent in the same deployment can be called as an `ask_<slug>` tool, bounded to one hop
- **GDPR Opt-out** — Deterministic STOP/START keyword gate per contact, enforced in code rather than by the model, blocking inbound and proactive outbound alike
- **Export & Import** — A full agent configuration (prompts, skills, tools, channels, hooks, MCP servers, Room, tasks) travels as a JSON bundle; secrets are never exported

## Documentation

The full documentation lives at **[docs.polyant.ai](https://docs.polyant.ai)** (source: [polyant-ai/docs](https://github.com/polyant-ai/docs)).

### Get started

- **[Getting Started](https://docs.polyant.ai/getting-started/quickstart)** — build your first agent in 10 minutes
- **[Channels Setup](https://docs.polyant.ai/getting-started/connect-a-channel)** — Telegram, Slack, WhatsApp recipes
- **[Examples](examples/README.md)** — minimal instance, skill, and tool templates

### Operate

- **[Deployment](https://docs.polyant.ai/operations/deployment)** — Docker Compose, Render, Fly.io, Kubernetes
- **[Upgrading](docs/UPGRADING.md)** — version-to-version upgrade steps that need an operator decision

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

## Channels

| Channel | Protocol | Notes |
|---------|----------|-------|
| **HTTP API** | OpenAI-compatible (`/v1/chat/completions`) | Instances appear as selectable models |
| **Telegram** | Long polling (grammY) | Text, photos, document attachments |
| **Slack** | Socket Mode (@slack/bolt) | Per-instance configuration |
| **WhatsApp** | Webhook via Twilio (Auth Token or API Key) | Text and media attachments |

All channel configs are stored encrypted per-instance. Adapters start/stop dynamically without a restart.

## Plugins & the SDK

Polyant is **framework-first** — it ships generic tools, and domain-specific ones (a CRM's
booking flow, a billing lookup) live in **plugins**: external git repos of tool files the
engine loads at boot. A tool is a `*.tool.ts` file that default-exports a `defineTool(...)`
from **[`@polyant-ai/plugin-sdk`](https://github.com/polyant-ai/polyant-sdk)**, a small
stateless contract package:

```ts
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "bookAppointment",
  description: "Book an appointment in the CRM.",
  parameters: z.object({ patientId: z.string(), date: z.string() }),
  execute: async (input, ctx) => ({ status: "booked" }),
});
```

`defineTool` serializes the static Zod schema to JSON Schema inside your plugin's own realm,
so the engine and each plugin resolve their own copies of the SDK without breakage. Point
the engine at a plugin repo with `PLUGIN_DIRS`, or drop it into
`packages/engine/src/plugins/`.

Full authoring reference — schema rules, `plugin.json`, module resolution, the symlink trap:
**[docs/plugins.md](docs/plugins.md)** and the
[SDK README](https://github.com/polyant-ai/polyant-sdk#readme).

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

See **[ROADMAP.md](ROADMAP.md)** for the direction, and
[GitHub Issues](https://github.com/polyant-ai/polyant/issues) and
[Discussions](https://github.com/polyant-ai/polyant/discussions) for the live list of planned
work and open requests.

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
