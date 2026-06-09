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
polyant/                            # Monorepo root
├── package.json                      # npm workspaces root (no deps, orchestration only)
├── .env                              # Single env file (shared by engine + docker-compose)
├── docker-compose.yml                # Infrastructure (postgres with pgvector, open-webui)
├── docker/                           # Docker customizations (reserved)
├── CLAUDE.md                         # This file
├── README.md
├── AGENTS.md
│
├── packages/
│   ├── engine/                       # @polyant/engine (NestJS)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts
│   │   ├── vitest.config.ts
│   │   ├── eslint.config.js
│   │   ├── src/
│   │   │   ├── index.ts              # Boot sequence + message pipeline
│   │   │   ├── config.ts             # Zod-validated env config
│   │   │   ├── workspace/            # Workspace resolver
│   │   │   ├── ai-gateway/           # Provider-agnostic LLM abstraction (tier-based)
│   │   │   │   └── providers/        # OpenAI + Anthropic adapters
│   │   │   ├── agents/
│   │   │   │   ├── supervisor/       # Central orchestrator
│   │   │   │   ├── sub-agents/       # SubAgentDefinition types
│   │   │   │   └── tools/            # Self-registering tools (*.tool.ts) + registry
│   │   │   ├── analytics/            # Pipeline latency tracing + latency query store
│   │   │   ├── memory/               # pgvector memory store, LLM extraction, hybrid search (RRF)
│   │   │   ├── conversations/        # PostgreSQL message store + FTS
│   │   │   ├── instances/            # Instance CRUD + secrets + channels + config resolver
│   │   │   ├── skills/               # Global skill library (SkillsService + controller)
│   │   │   ├── room/                 # Proactive agent workspace (event-driven)
│   │   │   │   ├── room.schema.ts   # 3 tables: instance_room, event_definitions, room_activity_log
│   │   │   │   ├── room.store.ts    # Room CRUD + state
│   │   │   │   ├── room-engine.ts   # ReAct cycle builder (supervisor invocation)
│   │   │   │   ├── room-scheduler.ts # Tick-based scheduler (30s interval)
│   │   │   │   ├── event-matcher.ts # LLM-based event classification (tier: fast)
│   │   │   │   └── activity-log.store.ts  # Daily→weekly→monthly log compaction
│   │   │   ├── webhooks/             # External event ingestion via HTTP webhooks
│   │   │   │   ├── webhook-engine.ts # Central dispatch + queue management
│   │   │   │   ├── webhook-matcher.ts # LLM-based event matching
│   │   │   │   ├── webhook-sources.store.ts # Event source + definition CRUD
│   │   │   │   ├── webhook-backlog.store.ts # Pending event queue
│   │   │   │   ├── webhook.validators.ts # Payload validation
│   │   │   │   ├── webhooks.schema.ts # Drizzle schemas
│   │   │   │   ├── trigger-context.ts # Context builder
│   │   │   │   ├── template-renderer.ts # Template rendering
│   │   │   │   ├── active-triggers.ts # Trigger state tracking
│   │   │   │   └── webhook-logger.ts # Audit logging
│   │   │   ├── hooks/                # Conversation lifecycle hooks (event → tool action)
│   │   │   ├── crypto/               # AES-256-GCM encryption module
│   │   │   ├── channels/adapters/    # Telegram, Slack, WhatsApp
│   │   │   ├── auth/                  # Authentication module (guard, schema, decorators)
│   │   │   ├── server/               # NestJS controllers + modules
│   │   │   │   ├── openai/           # /v1/chat/completions, /v1/models, /api/instances/:slug/chat/stream (typed SSE)
│   │   │   │   ├── instances/        # /api/instances CRUD + secrets + channels
│   │   │   │   ├── conversations/    # /api/conversations
│   │   │   │   ├── analytics/        # /api/analytics + /api/instances/:slug/analytics
│   │   │   │   ├── tools/            # /api/tools (read-only catalog)
│   │   │   │   ├── room/            # /api/instances/:slug/room + /webhooks/:token
│   │   │   │   └── memories/         # /memories
│   │   │   ├── database/             # Drizzle client + migrations
│   │   │   └── utils/                # Pipeline logger, frontmatter parser, title generator
│   │   └── workspaces/               # Per-conversation tool sandboxes (gitignored)
│   │       └── <instanceId>/conversations/<convId>/  # readFile/writeFile/gitCloneRepo scratch dir
│   │
│   └── web/                          # @polyant/web (Next.js)
│       ├── package.json
│       ├── next.config.ts
│       ├── tsconfig.json
│       ├── components.json           # shadcn/ui CLI config
│       └── src/
│           ├── app/
│           │   ├── globals.css       # Design tokens (@theme inline + :root + .dark)
│           │   ├── layout.tsx        # Root layout (Inter font, ThemeProvider)
│           │   ├── api/auth/         # Auth.js route handler
│           │   ├── (auth)/login/     # Google OAuth login page
│           │   └── (admin)/          # Admin route group (sidebar layout, protected)
│           │       ├── layout.tsx    # SidebarProvider + Sidebar + Header
│           │       ├── playground/   # Playground chat page
│           │       ├── memory/       # Memory management
│           │       └── */page.tsx    # Feature pages
│           ├── components/
│           │   ├── ui/              # shadcn/ui (managed by CLI)
│           │   └── layout/          # App sidebar, header, nav, theme toggle
│           ├── lib/
│           │   ├── utils.ts         # cn() helper
│           │   ├── api.ts           # API client for engine (proxied via Next.js rewrites)
│           │   ├── auth.ts          # Auth.js v5 config (Google, Drizzle adapter, DB sessions)
│           │   └── i18n/            # Internationalization (Italian/English)
│           ├── proxy.ts              # Auth proxy (redirect to /login if unauthenticated; Next 16 renamed middleware→proxy)
│           └── hooks/               # use-mobile, etc.
```

## Instance Configuration (Database-First)

**All instance configuration is stored in PostgreSQL — NOT on the filesystem.**

| Config | DB Table | Notes |
|--------|----------|-------|
| Prompts (8 sections) | `instance_prompts` | Seeded from `instances/defaults.ts` on create |
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

**When adding a new tool:** create a `*.tool.ts` file in `packages/engine/src/agents/tools/` that calls `registerTool()`. The tool self-registers at boot — no other files need to be modified. The `tools` DB table is synced automatically.

**`hubspotContact` supports custom properties:** the tool accepts a generic `customProperties: Record<string, string>` parameter for create/update (to write HubSpot custom properties like `evento`), and `filters` + `returnProperties` + `limit` + `after` for search (to query and paginate by custom property). The tool never hardcodes property names — instance-specific values (like an event name) live in the instance prompt, not in the tool code.

**`slackPostMessage` tool:** framework-first, generico (`packages/engine/src/agents/tools/slack-post-message.tool.ts`). Accetta `channel` (nome `#nome`, ID canale `C...` o ID utente `U...`) e `message`. Usa le credenziali del canale Slack configurato sull'istanza corrente via `channelManager.sendOutbound(instanceSlug, "slack", channel, message)` — lo Slack adapter risolve automaticamente gli ID utente aprendo un DM. Il canale di destinazione vive nel prompt dell'instance (no config extra). Il body del messaggio NON è loggato in audit (solo la lunghezza) per evitare leak di PII.

**When adding a new skill:** use the Management API (`POST /api/skills`) or create entries in the `skills` + `skill_versions` tables. Never create skill files on disk.

**When modifying prompts:** use the Management API (`PATCH /api/instances/:slug/prompts`) or update `instance_prompts` rows. Default prompt content for new instances is defined in `packages/engine/src/instances/defaults.ts`.

## Key Conventions

- **ESM only** (`"type": "module"` in package.json, `.js` extensions in imports)
- **npm workspaces**: always run `npm install` from the monorepo root. Use `-w <package>` to target a specific workspace
- **Single `.env` at monorepo root**: shared by engine and docker-compose. Engine finds it via `import.meta.url`-based path resolution (searches package root, then monorepo root)
- **Tier abstraction**: components request `fast | standard | heavy`, not specific models. Mapping in `packages/engine/src/ai-gateway/config.ts`
- **Fire-and-forget post-processing**: after each response, messages are saved, summary updated, and memories extracted asynchronously without blocking the user
- **Config via Zod**: all env vars parsed and validated in `packages/engine/src/config.ts`. Never read `process.env` directly elsewhere (documented exceptions: `DEFAULT_INSTANCE_ID`, `WORKSPACES_ROOT`, `LOG_LEVEL`). Altre letture intenzionali (filtri subprocess env, default params per testabilità, tool registry `requiredEnv` discovery) sono marcate con commento `// CONVENTION-EXCEPTION:` nel codice e devono restare circoscritte a quei pattern
- **Logging verbosity (`LOG_LEVEL`)**: the shared logger factory (`utils/create-logger.ts`) gates output by level (`debug | info | warn | error | silent`, default `info`) via the exported `shouldLog(level)`. `info` keeps the high-value pipeline skeleton (request, LLM token/latency, tool results, supervisor + response timing); `debug` adds verbose per-step tracing (LLM call lines, tool-call args, system-prompt **length only**, context load). The full system prompt is **never** logged — use the per-instance `debug_enabled` flag or `DEBUG_LLM_PAYLOAD` for full-payload inspection. `LOG_LEVEL` is read directly from `process.env` (CONVENTION-EXCEPTION) so the foundational logger never depends on the Zod `config` graph (which would invert layering and break partial `config`/`fs` test mocks). The file logger (`utils/file-logger.ts`) tees `console.*` to daily files and strips ANSI color codes so on-disk logs stay plain-text and grep-able. Tests run at `LOG_LEVEL=debug` (set in `test-setup.ts`)
- **Channel adapters are per-instance**: configs stored encrypted in DB, started/stopped dynamically via admin panel or API
- **Inbound message coordinator** (`packages/engine/src/channels/message-coordinator.ts`): fragmented bursts on WhatsApp/Telegram (user splits one thought across multiple quick messages) are collapsed into a single pipeline run per conversation via a cancel-and-restart model. First fragment arms a soft-debounce timer (`MESSAGE_SOFT_DEBOUNCE_MS`, default 2000ms) and a typing timer (`MESSAGE_TYPING_DELAY_MS`, default 1500ms). Additional fragments within the soft-debounce window reset both timers; when the pipeline fires it runs with an `AbortSignal`. A fragment arriving AFTER the pipeline has started aborts the in-flight run and re-arms the soft-debounce — up to `MESSAGE_MAX_RESTARTS` (default 3) consecutive cancel cycles, after which further fragments accumulate and are flushed in a follow-up run. On abort the in-flight fragments are restored to the head of the buffer (`restoreOnAbort`) so the next pipeline run ALWAYS contains every fragment still without a reply. Only `whatsapp` + `telegram` channels are routed through the coordinator — web/slack/room bypass. Fragment rows are NOT persisted separately: only the concatenated `user` message is saved, and only AFTER the pipeline succeeds (aborted runs leave no DB trace). Engine restart mid-buffer drops buffered fragments (acceptable trade-off)
- **WhatsApp typing indicator**: the `MessageCoordinator` schedules `sendTyping(channelId, messageSid)` on the WhatsApp adapter `MESSAGE_TYPING_DELAY_MS` ms after the first fragment of a burst (default 1500ms). The adapter calls Twilio's `/v2/Indicators/Typing.json` endpoint. The indicator shows the animated "typing…" dots for up to 25s (auto-expires on outbound delivery). As a documented side-effect, Twilio also marks the inbound message as read (double blue check). If a pipeline completes before the typing delay elapses, the call is never made. Failures are logged, not propagated
- **Pipeline cancellation**: `handleMessage(msg, signal?)` and `handleMessageStream(msg, signal?)` accept an optional `AbortSignal` propagated end-to-end (supervisor → `ai-gateway.chat`/`chatStream` → Vercel AI SDK `generateText`/`streamText`). The `MessageCoordinator` creates a fresh `AbortController` per pipeline run and aborts it when a new fragment arrives mid-flight. `runPipelinePost` and `afterResponse` are short-circuited on aborted signals: no trace record, no DB persistence of the user/assistant messages — cancelled pipelines leave zero side effects in DB. Tool HTTP fetches already in flight complete on the remote server but their results are ignored (accept-waste trade-off — documented risk on non-idempotent tools like `slackPostMessage`)
- **Conversation state store** (`packages/engine/src/conversations/state.store.ts` + `state.buffer.ts`): a per-conversation shared key/value blob (`conversation_state` table, `data` JSONB) that EVERY tool reads/writes via `ctx.state` (`get`/`set`/`getAll`/`delete`/`channel`). A `scope`/`scope_key` abstraction (today only `scope="conversation"`, `scope_key=conversationId`) leaves room for a future per-principal tier without a schema change. The **trusted channel identity** (phone / chat id / userName) is seeded server-side under the reserved `_channel` key every turn — read it via `ctx.state.channel` instead of trusting an LLM-supplied argument (injection-resistant). Writes are **deterministic, tool-code only — NEVER an LLM-facing `remember()` tool** — and **commit-on-success**: a per-run `ConversationStateBuffer` flushes in `runPipelinePost` AFTER the abort gate (Postgres per-key jsonb merge `||` / `- key`), so an aborted/cancelled run leaves no DB trace, exactly like messages/memory. Reads are buffer-first then DB (a tool sees its own writes + prior turns). Guards: JSON-serializable values, 64KB cap, audit logs key+type only (never the value — PII). Wired into the `deleteConversation`/`deleteInstance` cascades. Per-instance flag `state_in_prompt_enabled` (default OFF, toggle in the web Settings tab) renders a read-only state section into the supervisor prompt; default keeps state purely tool-to-tool. Buffer creation skips auto-tasks; the `_channel` seed skips synthetic channels (room/scheduled/agent). Distinct from `memory/` (semantic long-term pgvector) — this is structured, trusted, per-conversation working state
- **Conversation lifecycle hooks** (`packages/engine/src/hooks/`): per-instance, DB-configured (event → action) pairs run by `runHooks()` at four fixed pipeline points — `conversation_start` (first turn with empty persisted history — abort-safe vs the coordinator's cancel-and-restart), `message_received` (pre-LLM), `response_generated` (post-LLM, pre-flush), `response_sent` (end of pipeline post; semantics = "handed to channel", NOT delivered). Hooks are observe-only, ALL awaited (sequential, `position` order, per-hook timeout 1–30 s, default 10 s) and log-and-continue — a failing hook never blocks the reply. v1 action type is `tool`: a registered non-meta tool executed with statically-configured args whose `{{path}}` placeholders are rendered from the server-built event payload (never LLM output). Hook tools receive the turn's `ToolContext` including `ctx.state`; pre-event writes are visible to the supervisor in the same turn and ride the commit-on-success flush (`response_sent` writes get a second flush). Hooks bypass `instance_tools` enablement (deterministic admin config, like harness tools), skip auto-tasks + synthetic channels (`agent`/`scheduled`/`room`), and audit outcome only (never rendered args — PII). Every execution is ALSO recorded fire-and-forget in `hook_executions` (slug-keyed telemetry, `hook_id` intentionally not a FK; dropped by the deleteConversation cascade, preserved on instance delete like other telemetry) INCLUDING rendered args + truncated result (same exposure class as message `steps`; the global audit log stays outcome-only), exposed via `GET /api/conversations/:id/hooks` and rendered as expandable pills (input/output on click, shared `HookExecutionPill` component) in the conversation-detail timeline (a `message_received` pill legitimately precedes its user message row — that row is persisted commit-on-success at end of turn). `runHooks()` also returns `HookExecutionSummary[]`, threaded onto `StreamOutgoingMessage` so the typed SSE endpoint emits live `hook-execution` events (pre hooks after stream open, post hooks before `done` — which therefore awaits the synchronous post phase); the playground renders them on the assistant turn. Extensible via `action_type` + executor registry in `hook-runner.ts`. Managed via `GET/POST/PATCH/DELETE /api/instances/:slug/hooks` + web "Hooks" tab. Design: `docs/superpowers/specs/2026-06-10-hook-system-design.md`
- **Tool-result replay (cross-turn)** (`packages/engine/src/conversations/tool-history.ts`): by default the model's cross-turn history is text-only (`getRecentMessages` selects `role`+`content`), so prior-turn `tool_use`/`tool_result` blocks are NOT replayed — a tool's output is invisible to the model on the next turn unless it was echoed into the reply text (the API is stateless; nothing is stored provider-side). Per-instance flag `tool_results_in_history_enabled` (default OFF, web Settings toggle) opts in: `preparePipeline` re-fetches the in-window rows and `buildHistoryWithToolResults()` reconstructs the assistant `tool-call` + `tool`/`tool-result` ModelMessages from the persisted `steps` (every call paired with a result — synthesized if missing; multi-step turns flattened to one parallel-call shape), truncated to `MAX_REPLAYED_RESULT_CHARS` (2000). Extra fetch ONLY when the flag is on — the default text path is untouched, and dropped messages/summary stay text. CAVEAT: the AI SDK v6 message shape is unit-tested but should be validated against a live provider before enabling in production. The dormant `ai-gateway/reasoning-injector.ts` (Anthropic signed-thinking re-injection) is a separate, currently-unwired mechanism — do not conflate
- **Per-turn debug capture** (`debug_enabled` flag): by default the exact LLM request is NOT persisted — only `role`/`content`/`steps`/`reasoning` survive on the message row, so the full system prompt, the messages array sent, and the tool definitions are discarded after the call (only LangSmith, if enabled, keeps them externally). Per-instance flag `debug_enabled` (default OFF, web Settings toggle) opts in: the gateway captures `{ system, messages, tools }` when `ChatRequest.captureDebug` is set (threaded pipeline → supervisor → gateway; tool params serialized best-effort via `zod-to-json-schema`, degrading to name+description), returns it on `ChatResponse.debugPayload`, and `afterResponse` persists it to `conversation_messages.debug_payload` (jsonb, nullable). It is NEVER selected by the default `getMessages` list query — fetched on-demand via `GET /api/conversations/:id/messages/:messageId/debug` (returns `{ debugPayload, steps }`, scoped by conversationId, messageId UUID-guarded). The web `DebugSheet` (shared by playground + conversation detail) renders it on click; the streaming handler pre-generates the assistant message UUID and the native `chat/stream` controller echoes `{ conversationId, messageId }` in the `done` SSE event so the playground addresses the persisted turn without ordinal-matching. Heavy + PII at rest — opt-in only; persisted behind the same abort/commit-on-success gate as messages, cascaded on delete. A separate `GET /api/conversations/:id/state` exposes the conversation state-store snapshot (read-only) for the web "Context store" panel
- **Native typed-SSE chat endpoint** (`POST /api/instances/:slug/chat/stream`, `instance-chat-stream.controller.ts`): the first-party endpoint the admin playground uses. Unlike `/v1/chat/completions` (OpenAI-compat, text-only with `<think>` markers), it emits a typed SSE stream (`step-start`/`step-finish`/`reasoning-delta`/`reasoning-signature`/`reasoning-redacted`/`tool-call`/`tool-result`/`text-delta`/`done`/`error`) mapped from the AI SDK v6 `fullStream`, exposing the full multi-step + reasoning timeline live. `@Public()` + per-instance API key auth (shared `validateInstanceApiKey` helper, same as `/v1`). Aborts the pipeline on client disconnect; `done` carries `{ conversationId, messageId }`
- **Per-instance config**: AI keys, LangSmith, auth, channels, and Tavily are stored per-instance in `instance_secrets`/`instance_channels` tables. Resolved at runtime via `config-resolver.ts` (30s TTL cache). Only infrastructure vars remain in `.env`/`config.ts`
- **Tool registry**: tools self-register via `registerTool()` in `*.tool.ts` files under `packages/engine/src/agents/tools/`. Auto-discovered at boot by `loadAllTools()`. The supervisor queries `getToolRegistry()` — no hardcoded tool imports. Per-instance enablement stored in `instance_tools` table (auto-recomputed when skills change)
- **Global skill library**: skills are stored in `skills` + `skill_versions` DB tables. `SkillsService` manages listing/CRUD via `/api/skills`. Per-instance assignments in `instance_skills` table
- **Sub-agent types**: `SubAgentDefinition` interface in `packages/engine/src/agents/sub-agents/types.ts`
- **Instance personalization**: prompts, skills, tool availability are stored in PostgreSQL (`instance_prompts`, `instance_skills`, `instance_tools`), NOT on the filesystem
- **Independent deployment**: each package under `packages/` is deployable as a standalone service
- **Framework-first, never instance-specific**: Polyant is a general-purpose framework for creating virtual assistants of any kind. Code changes (tools, prompt templates, supervisor logic, pipeline) MUST be domain-agnostic. Never hardcode instance-specific logic (e.g., sales workflows, medical terminology, specific tool orchestration patterns). Instance-specific behavior is configured entirely through per-instance data: prompts, skills, tool enablement, and secrets. If a behavioral issue is found in one instance, the fix must be a general-purpose mechanism that any instance can leverage
- **Room is event-driven, not conversational**: the Room scheduler processes pending events on a 30s tick, not on user messages. Each cycle creates a **new conversation** (`room:{instanceId}:{timestamp}`) — never persistent. Human replies on the outbound channel trigger an immediate cycle via `triggerImmediate()`
- **Event matching uses LLM tier "fast"**: sequential evaluation, first match wins. Definitions are priority-ordered
- **Harness tools bypass instance_tools**: tools with `harness: true` are not in the `instance_tools` table. They are injected by the engine when `includeHarness` matches their category (e.g. `"room"`). The supervisor's `buildTools` skips the enabledNames gate for harness tools
- **Channel boot is fire-and-forget**: `channelManager.startAllForInstance()` is NOT awaited at boot — Slack socket mode can hang and block the entire startup sequence (schedulers, room scheduler). Errors are logged, not thrown
- **Title generation is shared**: `packages/engine/src/utils/title-generator.ts` provides `generateConversationTitle()` used by both the main pipeline (`index.ts`) and the room engine. Never duplicate the title prompt inline
- **GDPR opt-out (STOP/START)**: deterministic keyword gate runs at two chokepoints — a pre-LLM inbound gate at the top of `handleMessage`/`handleMessageStream` (short-circuits opted-out contacts; `runOptoutGate` in `packages/engine/src/optout/optout-gate.ts`) and outbound suppression inside `channelManager.sendOutbound`/`sendOutboundTemplate` (blocks proactive sends, coordinator bypasses with `skipOptoutCheck`). Opt-out state persisted per `(instanceId, channelType, channelId)` in `contact_optouts` table (cascade on instance delete, NOT on conversation delete). Config lives as six columns on `instances` (opt-out enabled, stop/resume keywords, closing/resuming messages, prompt-hint enabled). The LLM is never the enforcer; the keyword is injected into the supervisor prompt purely as informational context. Admin endpoints: `GET/POST/DELETE /api/instances/:slug/optouts`. v1 limitation: STOP as a reply to a Room broadcast is not honored. Spec: `docs/superpowers/specs/2026-06-11-gdpr-optout-design.md`

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

- **Update CLAUDE.md**: evaluate if the feature introduced new conventions, caveats, or architectural decisions that should be documented here for future sessions

## Important Caveats

- **Embeddings are per-instance, provider-aware.** Each instance has `embedding_dim` (1024 or 1536). OpenAI-provider instances can use either dim; Bedrock-provider instances are always 1024 (Titan v2). Anthropic-provider instances fall back to OpenAI for embeddings and must configure `openai_api_key`. The `embeddings-gateway` module picks the right model + credentials based on the instance. The `memories` and `knowledge_chunks` tables have two parallel vector columns (`embedding vector(1536)`, `embedding_1024 vector(1024)`) with an XOR check constraint — exactly one is populated per row, decided by the owning instance's `embedding_dim`. Switching provider on an existing instance triggers a re-embed job.
- **AI SDK v6 shape is isolated at the ai-gateway boundary** — the v6→internal mapping lives in `ai-gateway/providers/base.ts`: `normalizeSdkSteps()` maps `toolCall.input`→`args`, `toolResult.output`→`result`, `step.reasoning`→`reasoningDetails`; `mapUsage()` maps `inputTokens`/`outputTokens` (from `result.totalUsage`) → `promptTokens`/`completionTokens`. The internal types (`SdkStep`, `TokenUsage`, `StepDetail`) stay stable, so the rest of the codebase is untouched by the major bump. Other v6 renames already applied: multi-step uses `stopWhen: stepCountIs(n)` (was v4 `maxSteps`); tools declare `inputSchema` (was `parameters`); messages are typed `ModelMessage` (was `CoreMessage`); OpenAI non-strict JSON Schema is forced via `providerOptions.openai.strictJsonSchema=false` in `resolveCallConfig` (replaces the removed `createOpenAI({ compatibility })` / `structuredOutputs`)
- **Memory extraction is conditional** on the instance's `memoryEnabled` flag. The extraction prompt includes today's date and converts relative dates to absolute. Facts are written in the same language as the conversation.
- **No specialized sub-agents** — `spawnTask` creates ad-hoc agents; the `SubAgentDefinition` type exists for future extensions
- **Hybrid search uses RRF** (Reciprocal Rank Fusion) to merge pgvector cosine similarity results with PostgreSQL FTS keyword results
- **PostgreSQL FTS uses `simple` config** (no language-specific stopwords) to support multilingual content
- **Memory extraction** runs fire-and-forget after each response: the LLM extracts facts as structured JSON (content, category, importance), which are embedded and upserted into the `memories` table with cosine-similarity deduplication (threshold 0.90)
- **tsx and NestJS DI**: `tsx` (esbuild-based) does NOT support `emitDecoratorMetadata`. All NestJS constructor injection MUST use explicit `@Inject(ClassName)` — implicit type-based injection silently resolves to `undefined`. This is enforced by the custom ESLint rule `polyant/require-inject-in-nest-classes` (`packages/engine/eslint-rules/`): it flags any constructor parameter in an `@Injectable`/`@Controller`/`@Catch` class that lacks an `@Inject(...)` decorator. Plain classes instantiated with `new` (e.g. the channel adapters) are intentionally ignored
- **drizzle-kit with ESM**: `drizzle-kit generate` (run via the bare CLI, e.g. `npx drizzle-kit generate`) fails in this repo because of an ESM resolution issue. The `npm run db:generate` script wraps the workaround (`tsx ../../node_modules/drizzle-kit/bin.cjs generate`) so contributors can just run `npm run db:generate -w @polyant/engine` — invoking the CLI directly remains broken. No snapshot files exist, so `generate` always produces full-schema migrations — write incremental migrations manually
- **Next.js env loading**: Next.js only loads `.env` from its own package directory (`packages/web/`), NOT from the monorepo root. Auth vars (`AUTH_SECRET`, `DATABASE_URL`, `GOOGLE_*`) must be in `packages/web/.env.local` or duplicated
- **Next 16 conventions**: the auth middleware is `packages/web/src/proxy.ts` (Next 16 renamed `middleware.ts`→`proxy.ts`; the matcher still excludes `api`/`_next`/static so proxied API + `/v1` routes are NOT gated by the web session). Web lint runs as `eslint .` (the `lint` script) against native flat config (`eslint-config-next/core-web-vitals` + `/typescript`) — `next lint` was removed in 16; the newly-tightened react-compiler rules are currently kept at `"warn"` pending a dedicated follow-up. The root `package.json` `overrides.next` MUST track the installed Next major, or next-auth pulls in a second `next` copy. Auth.js route handlers are wrapped as plain `GET`/`POST(req: NextRequest)` in `app/api/auth/[...nextauth]/route.ts` because Next 16 type-checks handlers against `RouteHandlerConfig` (dynamic `params` is now a `Promise`)
- **Pipeline latency tracing** records per-phase timing for every user message (context prep, tool building, LLM call, total). Data is written fire-and-forget to `pipeline_traces` via a buffered `TraceStore` (flush every 10 entries or 5s). Tool call durations and streaming TTFB are also captured. Auto-tasks (Open WebUI title/summary) are excluded via `isAutoTask()` guard. The `ai_logs` table tracks individual LLM calls; `pipeline_traces` tracks end-to-end pipeline latency — they serve different purposes
- **Room scheduler is a singleton** (`roomScheduler`) with per-room mutex via a `running` Set. Multiple rooms process in parallel, but the same room never runs concurrently. The tick uses a batch query (`countPendingByInstance`) to avoid N+1
- **Webhook receiver always returns 200 OK** — processing is fire-and-forget. Events are dropped (not queued) if backlog cap (100) is reached. Payloads are limited to 64KB
- **Event source operations are instance-scoped**: all event source and definition mutations verify ownership via `instanceId` — event sources directly in the WHERE clause, definitions via `verifyEventSourceOwnership()` which confirms the parent event source belongs to the instance. The `mark_events_completed` harness tool also scopes by `instanceId`. This prevents IDOR across instances
- **`gitCloneRepo` credential lifecycle (#87)**: the GitHub token and the credential helper are written to `.git/polyant-token` (mode 0600) and `.git/polyant-askpass.sh` (mode 0700) inside each cloned workspace so that subsequent git operations (push/fetch by Claude Code) can authenticate. Both files are removed automatically by `cleanupRepo()` when the conversation ends and by `cleanupStaleRepos()` (stale threshold: 2h). **Trade-off**: while the workspace exists, the token is at rest on disk. Workspaces must be treated as ephemeral sandbox state: never backup/rsync/tar/commit them, never expose `workspaces/<instanceId>/` via any external share. A warning is logged if a leftover `.git/polyant-token` is detected during stale cleanup — that signals a crashed prior run

## Authentication & Authorization

### Current (Phase 1)

- **Frontend**: Auth.js v5 with Google OAuth; optional domain allowlist via `AUTH_ALLOWED_DOMAINS` env var (comma-separated, empty = allow all)
- **Session strategy**: JWT (encrypted JWE with A256CBC-HS512). Chosen because Next.js middleware runs in Edge Runtime which cannot make TCP/DB connections
- **JWT validation (engine)**: `auth-user.service.ts` decrypts Auth.js JWE using `jose` + `@panva/hkdf` with `AUTH_SECRET`. No DB query per request
- **Engine guard**: Global NestJS `AuthGuard` (registered via `APP_GUARD`). Reads JWT from `Authorization: Bearer <token>` header OR `authjs.session-token` cookie. Uses `@Inject(Reflector)` explicitly (tsx doesn't support `emitDecoratorMetadata`)
- **Public routes**: Decorated with `@Public()` — `/health`, `/v1/*` (the OpenAI-compatible API)
- **Completion API auth**: `/v1/chat/completions` uses per-instance API keys (existing mechanism: `instance_secrets` + `authEnabled` flag). NOT session-based
- **Frontend proxy**: Next.js rewrites proxy `/api/*` and `/memories/*` to the engine, forwarding cookies (JWT included)
- **DrizzleAdapter**: configured with custom schema mapping in `packages/web/src/lib/auth.ts` (snake_case DB columns, pluralized table names matching engine schema)
- **JWT trade-offs**: no immediate session revocation (valid until 30d expiry); user data frozen in token; `AUTH_SECRET` is single point of failure. If revocation needed later: short-lived JWT (15min) + refresh rotation is recommended path

### Auth module files

```
packages/engine/src/auth/
  auth.module.ts             — NestJS module (provides APP_GUARD + Reflector)
  auth.guard.ts              — Global guard (JWT from cookie or Bearer header)
  auth-user.service.ts       — Decrypts Auth.js JWE token (jose + hkdf)
  auth.types.ts              — AuthenticatedUser interface
  users.schema.ts            — Drizzle schema (users, accounts, sessions, verification_tokens)
  decorators/
    public.decorator.ts      — @Public() marks route as unauthenticated
    current-user.decorator.ts — @CurrentUser() param decorator
packages/web/src/lib/auth.ts — Auth.js config + custom Drizzle schema for adapter
```

### Gateway-authenticated mode (`AUTH_MODE=<gateway>`)

When the engine runs behind a cloud-managed auth gateway (ALB OIDC on AWS, GCP IAP, Cloudflare Access, Azure Easy Auth — future), set `AUTH_MODE` to the gateway name (currently only `alb-oidc` is implemented). `auth.guard.ts` dispatches on this value: in gateway mode it reads the identity header set by the gateway (`x-amzn-oidc-data` for ALB OIDC) via a per-gateway parser (`alb-oidc.service.ts`) instead of validating an Auth.js session. The header's JWT signature is NOT verified; the engine relies on network isolation (ECS security group accepts ingress only from the ALB SG) — this is documented in [ADR-0001](docs/adr/0001-gateway-authenticated-mode.md) along with the trust trade-offs and the deferred follow-up for signature verification. In this mode the `packages/web` container does NOT need `AUTH_SECRET`/`POSTGRES_*`/`GOOGLE_*` — Auth.js Edge middleware finds no `authjs.session-token` cookie (the gateway uses its own cookie), returns null without decrypting, and the engine becomes the sole source of authenticated identity. When adding a new gateway, add a new parser file under `packages/engine/src/auth/` and a new `AUTH_MODE` value; do NOT branch on cloud-specific logic inside `auth.guard.ts`.

### Future (Phase 2 — Multi-Tenancy)

Planned hierarchy: **Organization > Project > Instance**

- Organizations own projects, projects contain instances
- Users belong to organizations via membership (invitation-based)
- Configurable RBAC per organization (roles → permissions)
- URL format: `/organizations/{orgSlug}/projects/{projectSlug}/instances/{slug}/...`
- Schema design: `organizations`, `projects`, `organization_memberships`, `roles`, `invitations` tables

### Environment variables for auth

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes (web) | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes (web) | Google OAuth client secret |
| `AUTH_SECRET` | Yes (web + engine) | Auth.js JWT encryption secret (32+ random chars). Must be identical in both packages — engine uses it to decrypt JWE tokens |
| `AUTH_TRUST_HOST` | No | Set to `true` behind reverse proxy |
| `DATABASE_URL` | Alt (web) | PostgreSQL connection string for Auth.js adapter. Web needs this in `.env.local` or root `.env` (Next.js doesn't auto-load monorepo root `.env`) |

## Instances Architecture

The project supports multiple AI assistant **instances**, each with its own configuration:

- **Instance = shared assistant configuration**: an instance defines personality, tools, skills, and can serve multiple users. Identified by `instanceId` throughout the codebase (DB columns: `instance_id`)
- **Branded identifiers (`InstanceSlug` vs `InstanceUuid`)**: the two instance identifiers are distinct branded string types in `packages/engine/src/instances/identifiers.ts`. The human-readable `slug` (`instances.slug` — the external contract: API `model` field, URL `:slug`, channel keys, workspace dirs, `conversationId` prefix) is `InstanceSlug`; the `instances.id` UUID and the FK columns referencing it are `InstanceUuid`. Slug-text tables (memories, conversations, knowledge, scheduled_tasks, audit, traces, ai_logs) store the slug → their store functions take `InstanceSlug`; uuid-FK tables (room, prompts, secrets, channels, instance_skills, instance_tools, skill_env, webhooks/event sources + event_backlog) store the UUID → their store functions take `InstanceUuid`. The ONLY sanctioned slug↔UUID conversion is `resolveInstanceId(slug)` / `resolveInstanceSlug(id)` in `resolve-instance-id.ts`. `asInstanceSlug` / `asInstanceUuid` are zero-cost (runtime identity) casts — use them ONLY at trusted boundaries (DB row reads, validated `@Param`, config constants). A plain `string` is not assignable to a brand, so the compiler now prevents the silent "zero rows" mismatch that used to occur when a slug reached a UUID query (or vice versa)
- **DB table `instances`**: metadata (slug, name, description, status, memoryEnabled, langsmithEnabled, authEnabled)
- **OpenAI-compatible API**: exposes instances as models — clients select an instance via the `model` field
- **Config in DB**: prompts, skills, tools, secrets, channels stored in PostgreSQL (filesystem only used for knowledge files)

### Management API (implemented)

- **Instance CRUD**: `GET/POST/PATCH/DELETE /api/instances` + `GET /api/instances/models`
- **Prompt management**: `GET/PATCH /api/instances/:slug/prompts`
- **Tool management**: `GET/PATCH /api/instances/:slug/tools`
- **Skill management**: `GET/PATCH /api/instances/:slug/skills` + skill env vars (`GET/PUT/DELETE`)
- **Secrets management**: `GET/PUT/DELETE /api/instances/:slug/secrets`
- **Channels management**: `GET/PUT/DELETE /api/instances/:slug/channels/:type`
- **Conversations**: `GET/DELETE /api/conversations` + messages
- **Memories**: `GET/POST/DELETE /memories`
- **Analytics**: `GET /api/analytics` + `GET /api/instances/:slug/analytics`
- **Global skill library**: `GET/POST/PUT/DELETE /api/skills`
- **Tool catalog**: `GET /api/tools` (read-only registry list)
- **Room**: `GET/PUT/DELETE /api/instances/:slug/room` + event sources CRUD + definitions CRUD + backlog query + activity log
- **Hooks**: `GET/POST/PATCH/DELETE /api/instances/:slug/hooks`
- **Webhooks**: `POST /webhooks/:webhookToken` — external event ingestion with LLM-based matching

### Admin Panel (implemented)

- Instance management (CRUD, provider/model selection, status toggle)
- Prompt editing (8 sections with accordion UI)
- Tool toggling (enable/disable per instance)
- Skills management (enable/disable, env var configuration with encryption)
- Settings tab (per-instance API keys, auth toggle, LangSmith toggle, memory toggle)
- Channels tab (Telegram, Slack, WhatsApp config with encrypted storage)
- Playground page (chat with instances, auth token persistence)
- Analytics dashboard (KPI graphs, per-instance metrics)
- Conversation browsing (paginated list, full-text search, message detail)
- Memory management (paginated list, search, create/delete)
- Room tab (room config, event sources with inline definition editing, backlog queue with status filter, activity log)
- Hooks tab (lifecycle event → tool action with template args)
- Internationalization (Italian/English with live switching)
- Dark/light theme

## Development Layers (Claude Code)

This project ships with a set of layered Claude Code helpers under `.claude/`:
- **Rules** (`.claude/rules/`): enforced constraints (always loaded). Coding style, security, testing, git workflow, performance, TypeScript conventions.
- **Hooks** (`.claude/hooks/`): automatic enforcement (pre-commit secrets check, post-edit lint, console.log warning).
- **Agents** (`.claude/agents/`): 8 specialized agents (planner, code-reviewer, architect, tdd-guide, security-reviewer, doc-updater, build-error-resolver, refactor-cleaner).
- **Contexts** (`.claude/contexts/`): behavioral modes (dev, review, research).
- **Commands** (`.claude/commands/`): `/plan`, `/tdd`, `/brainstorming`, `/review`, `/verify`, `/security-scan`.
- **Skills** (`.claude/skills/`): project-specific knowledge (backend-architecture, frontend-design-system).
