# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-10-06

> **Upgrading from 1.1.2 needs operator action.** The engine and the panel run
> on Node 24. Google sign-in is removed. Several built-in tool families now
> require plugins (agents keep them enabled under their new names), and custom
> S3 endpoints are no longer supported. Storing inbound attachments becomes a
> per-agent choice, off for every agent. Telegram and Slack arrive through
> webhooks and need a public address. Environment variables that set product
> behaviour are gone, and a non-default value has to be entered in the panel
> before the upgrade. Migration `0086` rewrites the conversations table. See
> [docs/UPGRADING.md](docs/UPGRADING.md).

### Added

- A `createSkill` tool lets an agent write a skill from the conversation and
  enable it on itself. It is opt-in: no agent has it until an operator enables
  it in the agent's tools.
- Settings → General holds the installation's operational policies, for a
  platform admin: analytics retention, the engine's public address, the
  per-user and global live-stream caps, the rate-limit window and request
  limit, the agent-to-agent and MCP connection timeouts, and the two scheduler
  deadlines. Each is empty until set, and an empty field shows the value in
  force as its placeholder.
- Agents can set their timezone, locale, memory-deduplication threshold and
  message-coordination timings from their Settings page, and an organization's
  knowledge-document cap can differ from the shipped default without a
  redeploy.
- The engine's public address can be corrected without a redeploy. `BASE_URL`
  stays as the value the deployment boots with; the stored address wins where
  one is set, and every webhook URL, OAuth redirect and agent card is built from
  the resolved value.
- Web chat context: `POST /api/instances/:slug/chat/stream` (and
  `/v1/chat/completions`) accept a `context` object that is projected onto the
  conversation state before the turn, through a per-agent web context field
  mapping edited under Channels → Web/API, so a voice or web front end hands
  tools and hooks the caller's identity and keeps streaming. A request with
  context requires `chat_id` and the agent's API key, and an agent that maps at
  least one context field requires its key on every web turn, with or without
  context, even when its authentication is otherwise off. Migration `0085` adds
  the column.
- `_private` is a reserved conversation-state key that is stored and returned by
  the state API but never rendered into the prompt. The whole underscore
  namespace is reserved: neither the web context mapping nor the HTTP channel
  mapping may target an underscore key.
- A conversation can be followed live from its detail page, on any channel:
  `GET /api/activity-stream/conversation` streams one conversation's activity
  and signals each committed write, gated by `conversation:read` and sharing the
  live-stream caps. Tool calls now reach the activity stream, so the activity
  panel shows them, and the Playground follows the same detailed-view
  preference as Conversations.
- Conversation activity is shown as a lightweight timeline.
- Scheduled tasks recover after a process dies or a run exceeds its deadline.
  `GET /health/scheduler` reports free slots and stuck runs, and migrations add
  per-task `max_run_ms` plus an index for running tasks.
- Models: OpenAI's gpt-6 family (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`),
  Claude Opus 5, Opus 5.5, Sonnet 5.5 and Fable 5.1, and on Nebius GLM-5.3,
  GLM-5.3-Flash, DeepSeek V4.1 Flash, DeepSeek V4 Pro 0813, Kimi K3, MiniMax M3
  and Nemotron 3.5 Lightning. On Bedrock, Claude Opus 5 and Opus 5.5 (EU and
  global profiles) and Sonnet 5.5 (global only, the one profile AWS publishes
  for it).
- AI providers and OpenAI-compatible embedders can be registered at boot
  (`registerAiProvider`, `registerEmbeddingProvider`) instead of edited into the
  maps every request reads. The embedder selector in an agent's settings lists
  what the server serves rather than a hardcoded pair.
- `readFile` accepts `offset` and `limit` and returns that line range with the
  file's total line count, so an agent can read part of a large document without
  carrying the whole file through the rest of the turn.
- Plugin manifests can declare runtime packages and environment values. The
  Docker build compiles plugins placed under `packages/engine/src/plugins/` and
  installs only the system dependencies those plugins request.
- Plugin manifests accept optional `displayName` and `description`, and a
  `requiredSecrets` entry can carry a `label` and a `description`; the panel
  uses them to present the plugin and the fields its tools ask for.
- The agent's Tools section lists enabled tools with their origin, opens each
  tool in a side sheet with the parameters it declares, and enables new ones
  from a picker. Hooks open in the same kind of sheet, with their event,
  timeout, order and parameters saved together.
- The agent page explains what a capability still needs before it works, such
  as transcription credentials, instead of leaving it enabled and silent.
- The Debug sheet can copy a complete captured turn — model payload and step
  trace — as one JSON object.
- `POSTGRES_POOL_MAX` sets the main Postgres pool (default 10).
  `POSTGRES_ANALYTICS_POOL_MAX` (default 3) and
  `POSTGRES_ANALYTICS_STATEMENT_TIMEOUT_MS` (default 15 seconds) size the new
  analytics pool and bound its statements.

### Changed

- **BREAKING — the LangSmith trace metadata key `oa_conversation_id` is now
  `conversation_id`.** Dashboards and filters built on the old key need
  updating.
- **BREAKING — the engine and the panel run on Node 24**, the active LTS. The
  published images carry it; a deployment that runs from source or builds its
  own images must move to Node 24, and Node 22 is no longer tested. Under load
  the platform's overhead per turn fell sharply, because Node 24 no longer
  implements `AsyncLocalStorage` through promise hooks.
- **BREAKING — GitHub, Render, HubSpot and Markdown-to-PDF tools moved out of
  core into plugins.** Their names are namespaced (`ghIssue` becomes
  `github:issue`, `hubspotContact` becomes `hubspot:contact`, and
  `markdownToPdf` becomes `extra:markdownToPdf`). Migration `0087` renames the
  catalog rows in place, so agents keep the tools enabled and skills keep their
  links and required-tool lists; an import of an older bundle maps the old
  names too. The tools work again once their plugin is installed.
  `verifyDocument` was removed without a replacement: the first boot removes
  it, and any other tool no plugin provides, from the agents that had it and
  logs their names.
- **BREAKING — Telegram and Slack now arrive through webhooks.** Telegram used
  long polling and Slack Socket Mode, so both worked without a public address.
  Now the engine registers `<public address>/webhooks/telegram/<agent>` with
  Telegram, and Slack must be pointed at `<public address>/webhooks/slack/<agent>`
  with Socket Mode switched off; the Slack app token is no longer used. The
  engine needs a public HTTPS address and `/webhooks/*` must reach it.
- **BREAKING — attachment storage is configured per agent, and storing inbound
  files is opt-in.** The four `PLATFORM_S3_*` variables are gone; attachment
  persistence and `fileUpload` share the agent's bucket and support either
  static credentials or the explicit `s3_use_task_role` opt-in. An agent keeps
  the files its users send only when **Store attachments** is on in its
  behaviour parameters; migration `0088` adds the switch off for every agent,
  and the model sees each file in the turn either way. Stored files are deleted
  with their conversation and with the agent. Files earlier versions stored in
  the platform bucket stay there; the upgrade guide shows how to copy them.
- **The OpenAI tiers moved to the gpt-6 family** (`fast` → `gpt-6-luna`,
  `standard` → `gpt-6-sol`, `heavy` → `gpt-6-astra`). They pointed at
  `gpt-4o-mini`/`gpt-4o`, which OpenAI lists as deprecated. Every OpenAI agent
  without a pinned model, and its background jobs, lands on the new models; the
  deprecated ones stay in the catalog so a pinned agent keeps its costs priced.
- Bedrock's default `standard` and `heavy` tiers no longer require Anthropic
  model access: they use Amazon Nova Pro and OpenAI gpt-oss 120B respectively.
  Nova keeps system-prompt caching without placing an invalid cache marker on
  tool messages.
- New agents start with memory off and audio transcription disabled until they
  are configured (migration `0083`); existing agents keep their settings.
- Prices corrected against the published pages: Claude Sonnet 5 is $2/$10 (it
  was recorded at $3/$15), the gpt-5.6 family came down, its cache writes are
  charged at the published 1.25× input rate, `o3`'s cached input is $0.50, and
  Bedrock `eu.*` Claude 4.5+ profiles carry the 10% regional premium, where none
  was modelled. Anthropic cache writes are priced by their TTL, and traces
  record five-minute cache-write tokens separately (migration `0084`).
- A hook that returns `regenerate` or `injectContext` on a Room or webhook turn,
  where those controls are not honored, now logs a warning naming the hook and
  the dropped control.
- The plugin SDK is pinned at v1.9.0. SDK 1.9.0 declares `ctx.artifacts` on
  `ToolContext`, so plugin tools read it from the SDK's own types; `put` and
  `take` may return a promise and must be awaited. The SDK's knowledge-access
  declarations (`requiredKnowledge`, `ctx.knowledge`) are not implemented by
  this engine: a plugin that declares them is loaded, but gets no knowledge
  base handle.
- Runtime dependencies moved to NestJS 12, AI SDK 7, React 19.3, Vitest 5,
  dotenv 18, jsdom 30 and markdown-it 15.
- Telegram webhook registration happens after the channel starts and is
  retried on rate limits and transient errors, so a failed registration no
  longer disables the channel. Telegram updates are acknowledged before the
  turn runs.
- Conversations carry their message count, user message count and time of
  the last message. The conversation list, the conversation detail, the
  search and the analytics read them instead of counting messages, so their
  cost no longer grows with message history. On 2 million messages the
  analytics queries run 4 to 10 times faster.
- Dashboards and other analytics reads run on their own connection pool, so a
  heavy aggregate no longer holds the connections a conversation turn needs.
- Connections to MCP servers that do not use OAuth are reused across turns
  for up to a minute, instead of a new handshake on every turn. A connection
  that fails is retired and the next turn opens a fresh one.
- A model call no longer reads the agent's row from the database: the agent's
  identity is cached for a minute and dropped when the agent changes.
- The panel loads the changelog only for a Platform Admin, and loads the
  changelog card's markdown renderer only when the dialog opens.

### Removed

- **BREAKING — Google sign-in is removed.** Email and password is the only
  sign-in method in this edition. Accounts that only used Google need a password
  before upgrading; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and the
  deployment-wide domain allowlist are gone.
- **BREAKING — `s3_endpoint` is removed.** Migration
  `0081_drop_s3_endpoint_secret` deletes stored values. MinIO, Cloudflare R2 and
  other custom endpoints are unsupported in 1.2.0 and fall back to AWS
  addressing.
- **BREAKING — deployment configuration was narrowed.** `AUTH_MODE`,
  `DEFAULT_INSTANCE_ID`, `AWS_REGION`, `PLATFORM_ADMIN_EMAIL`,
  `WORKSPACES_ROOT`, `DEBUG_LLM_PAYLOAD` and the unused `LANGSMITH_*` variables
  are no longer product configuration.
- **BREAKING — ten environment variables that the panel already answers.**
  `DATETIME_TIMEZONE`, `DATETIME_LOCALE`, `DEDUP_SIMILARITY_THRESHOLD`,
  `MESSAGE_SOFT_DEBOUNCE_MS`, `MESSAGE_TYPING_DELAY_MS`, `MESSAGE_MAX_RESTARTS`,
  `KNOWLEDGE_MAX_DOCS_PER_INSTANCE`, `ANALYTICS_RETENTION_DAYS` and
  `SSE_MAX_CONNECTIONS_PER_USER` were the deployment default behind a value an
  administrator now sets per agent, per organization or per installation; the
  shipped defaults are unchanged and live beside the resolver that applies them.
  `PDF_CONCURRENCY` belongs to the Markdown-to-PDF plugin, which reads it itself.
  A deployment that still sets any of them is not failed, but the value has no
  effect.
- **BREAKING — seven more environment variables become panel settings.**
  `SSE_MAX_CONNECTIONS`, `THROTTLE_TTL_MS`, `THROTTLE_LIMIT`,
  `AGENT_CALL_TIMEOUT_MS`, `MCP_CONNECT_TIMEOUT_MS`, `SCHEDULER_ORPHAN_GRACE_MS`
  and `SCHEDULER_DEFAULT_MAX_RUN_MS` are now rows in `platform_settings`, edited
  in Settings → General, with the same defaults as before. `THROTTLE_ENABLED`
  stays an environment variable: it exists for parallel local runs, and a rate
  limiter that can be switched off from inside the product is no use to a
  locked-out administrator.
- The CDK stack no longer passes `DEFAULT_INSTANCE_ID` or `DATETIME_LOCALE` to
  the engine container, and sets the deployment's time zone as `TZ`. The `app`
  block of `config.yaml` keeps only `timezone`.

### Fixed

- The engine finishes shutting down while a panel holds an activity stream open.
  `SIGTERM` used to wait on that connection until the platform killed the
  process, so every deploy with a panel open waited out the stop timeout and
  lost the last buffered audit rows. Open streams are now ended first, and a
  request already in flight gets ten seconds to finish. Turns a Telegram,
  Slack, WhatsApp or event webhook has already acknowledged get the same ten
  seconds: their sender does not retry them, so cutting them off lost the reply.
- A Telegram channel went silent after every rolling deploy: the replica being
  stopped deleted the webhook the new one had just registered. The webhook is
  now removed only when the channel is switched off or deleted, or its agent is
  deleted.
- The CDK stack sends `/webhooks/*` and `/channels/http/*` to the engine without
  the OIDC sign-in. They fell through to the web panel, which answered 404, so
  inbound Twilio, email, HubSpot and HTTP-channel traffic never arrived on an
  ALB deployment.
- A Room's prompt reaches the model. It was editable in the panel and stored,
  but only ever used for a token estimate.
- A webhook event definition no longer drops a matching event because the model
  answered "Yes." or "Yes, …" instead of a bare "yes", and "si", "sì" or "y"
  count as a match only when they are the whole reply, so "Si tratta di…" no
  longer wakes the agent. The matcher sends the classifier the same projected
  payload the Room shows instead of the full JSON.
- `spawnTask` can be enabled on an agent, and the sub-agents it starts run on
  the agent's provider and pinned model and stop when the turn is aborted. Its
  file did not match the tool loader's naming
  pattern, so it was never registered and sub-agents were unreachable.
- An exported agent comes back as it left: the bundle carries the agent's
  thinking level and the values of tool and hook parameters declared not
  sensitive, which the import re-checks against its own registries.
  Credentials still travel as key names only.
- `chat/stream` now aborts the pipeline when the client disconnects before the
  turn has produced anything (no text, reasoning or tool call yet): the model
  stops and the abandoned turn is not persisted. Once the turn has produced
  something it runs to its end and is saved, so a tool that may have written is
  never left unrecorded.
- `chat/stream` stops relaying a turn when the client disconnects. It listened
  for the request's `close`, which Node emits once the body has been read, so a
  real disconnect was never seen.
- A streaming `/v1/chat/completions` request the pipeline refuses is answered
  with its error status. The stream used to open first, so the refusal arrived
  inside a 200 already being read, and the response ended without `[DONE]`.
- Switching thinking off now switches it off on models that reason by default —
  gpt-6 sol/luna and Claude Opus 5 and Sonnet 5 kept reasoning (and billing for
  it) when the parameter was simply omitted, on Bedrock as well as on the Claude
  API. Claude Sonnet 5.5 refuses the usual off-switch, so it gets
  `between_tools`, its lowest setting.
- Claude Fable 5 offered a thinking toggle that did nothing: the model reasons on
  every call. The toggle is now locked on, as it already was for Fable 5.1.
- The reasoning-level clamp could send `medium` to a model that does not accept
  it, and two capability checks looked a model up across providers by id alone.
- An agent on a registered embedder was reported as missing credentials: the
  readiness check asked for the OpenAI key regardless of the embedder.
- An unknown embedder name — from an import, or a stale row — fell through to
  OpenAI instead of failing; it now fails, and an import naming one is refused.
- A multi-step model call that fails at a later step is logged with the tokens
  and cost of the steps it completed, which the provider billed; it was logged
  at zero.
- The engine warns at boot for each retired environment variable still set,
  naming where its value is set now.
- Scheduled tasks no longer remain permanently `running` after a deploy or
  crash, and one malformed tool-audit entry no longer blocks the rest of an
  agent's audit trail.
- Scheduler startup recovery waits through each task's run deadline and does
  not overwrite an outcome already recorded by another process.
- Agent bundles preserve each scheduled task's run deadline; event-source edits
  and token rotation return 404 for missing sources; inbound messages use default
  timings when their settings lookup fails. In-process plugin artifacts now have
  bounded size, lifetime, storage per conversation and aggregate storage, and
  a handle produced in a turn without a conversation resolves only for the
  agent that produced it.
- A failed upload of an inbound attachment no longer loses the turn: the message
  and the reply are saved without the attachment's stored copy.
- One management-audit row the database refused (an over-long target id, say)
  stopped every later write of the management audit until 500 newer rows pushed
  it out. Refused rows are now dropped one by one, and values are cut to their
  column width.
- Tenant-scoped conversation and memory reads and mutations fail closed;
  unresolved request tenancy is refused instead of widening or silently losing
  a predicate.
- Agent behaviour overrides are persisted and type-validated, and two
  concurrent fragments can no longer overwrite each other while a message burst
  is starting.
- `fileUpload` is available with either supported credential shape. Attachment
  routes now accept Express 5 wildcard segments, and filenames containing
  spaces, `#`, `?`, or harmless dot runs remain reachable.
- An agent PATCH validates the provider and model the agent will run on
  together, whenever it changes either, so changing only the provider can no
  longer leave the agent pinned to a model of the previous one.
- Signed-out pages can switch language, and organization members cannot
  accidentally remove their own membership.
- MCP credential edits preserve omitted secrets, OAuth metadata receives the
  same URL validation as the server URL, A2A cancellation survives handler
  cache expiry, and the panel refuses to enable API-key authentication without
  a key.
- `docker build -f Dockerfile.web` works again: the web build reads
  `CHANGELOG.md`, which the image never copied.
- Telegram and Slack redeliveries of an update or event seen in the last hour
  are dropped instead of answered twice, and each bot's webhooks are rate
  limited on their own bucket instead of sharing one per client address. The
  CDK stack sets `TRUST_PROXY=1`, so the engine sees the caller's address
  behind the load balancer.
  The check is kept in memory in each process: with several replicas, a retry
  that reaches another replica is answered again. Run one replica, or accept
  the occasional duplicate.
- The scheduler reaper fails only the run it judged overdue, never a newer
  claim of the same task.
- A cron task that `scheduleTask` creates without a zone is stored with `UTC`,
  the default the tool describes, instead of running in the process zone.
- `/v1/chat/completions` with `stream: true` handles a client disconnect like
  `chat/stream`: a turn that has produced nothing is aborted, a turn that has
  produced output still runs to its end and is saved, and a heartbeat keeps
  the connection open through long tool calls.
- Analytics cost and token totals include what the provider billed for calls
  that failed after completing steps; call counts and response times still
  describe answered calls.
- An import normalises the web context field mapping as the panel does, and
  refuses an invalid one before writing anything.
- `readFile` caps `tail` at 500 lines like other windows, and its refusal of a
  file over 512 KB no longer suggests a range read that would also be refused.
- A variable a plugin declares in `system.env` no longer overrides the same
  variable set in the operator's container environment.
- `drizzle.config.ts` lists every schema file again; `drizzle-kit push` is not
  a supported path and the config says so.
- A failed load of Settings → General shows the reason with a retry instead of
  a skeleton.
- A Claude turn on Anthropic or Bedrock that ran three or more tool steps no
  longer fails. Each step added a cache breakpoint and kept the previous ones,
  so the request passed the provider's limit of four: Bedrock refused it with
  a 400 (the caller saw a 500) and Anthropic dropped the newest. The
  within-turn breakpoint now moves to the latest step.
- A scheduled run that finishes after the reaper failed it no longer clears
  the claim of the run that replaced it, nor deletes a one-shot task under it.
  A replica that claims a task another replica has just run no longer runs it
  a second time.
- On shutdown the schedulers stop first, so no task starts during the
  ten-second HTTP grace period to be cut off by the exit, and a step that fails
  (a trace-store flush against a database already gone, say) is logged and no
  longer keeps the process alive until the platform kills it.
- A WhatsApp or Telegram message sent while the previous answer was being
  cancelled is answered together with the earlier fragments in one reply. When
  the cancelled run took longer than the debounce window to stop, the contact
  got one reply to the new fragment and another to the old ones.
- A Telegram reply in flight when the channel is saved is still delivered, and
  Telegram file downloads stop after 30 seconds and refuse files over 20 MB.
- The engine warns at boot when a `PLATFORM_S3_*` variable is still set:
  1.2.0 no longer reads them.
- The upgrade guide's pre-step for migration `0086` built an index on
  `conversations.last_message_at`, a column 1.1.x does not have, so it failed.
  It now builds only the `conversation_messages` index ahead.
- The `fileUpload` credential fields are labelled in English.

### Security

- **BREAKING — each Telegram channel now has its own random webhook secret.** It
  used to be derived from the bot token, so anyone who had seen the token could
  forge updates. Existing channels get a new secret and re-register their
  webhook on the next engine start or channel enable; until then Telegram's
  deliveries fail verification. See docs/UPGRADING.md.
- Removed the agent-controlled S3 endpoint that could direct file PUTs and GETs
  to arbitrary hosts, including private network addresses.
- Closed cross-tenant keyword search and mutation paths by making tenant scope
  explicit, branded and fail-closed throughout the affected stores.
- Disabled skills can no longer resolve their retained credential placeholders;
  rotating bearer values no longer mint an unlimited series of throttle
  buckets; MCP OAuth endpoints use the shared SSRF denylist.
- Request-controlled channel identifiers are sanitized before logging, unknown
  imported channel types are rejected safely, and raw provider response bodies
  are no longer written to logs.
- Updated undici to 8.11.2 and 7.30.0 for its open security advisories. The
  Next.js, Sharp, js-yaml, Multer and qs updates already shipped in 1.1.2.
- Updated axios to 1.20.0 for twelve high-severity advisories in 1.19.0.
- The engine and web images run as the unprivileged `node` user instead of
  root, and declare a health check (`/health` on the engine, the sign-in page
  on the web). A volume mounted on the engine's `/app/logs` or
  `/app/packages/engine/workspaces` must be writable by uid 1000.

## [1.1.2] - 2026-09-24

Security patch release.

### Security

- Library updates for security reasons, including Next.js 16.3.6 in the admin panel.

## [1.1.1] - 2026-09-17

Patch release. It restores agent creation, which fails on every attempt in 1.1.0.

### Fixed

- **Creating an agent no longer fails.** `POST /api/instances`, and the admin
  panel's New Agent button behind it, answered 500 on every call in 1.1.0: the
  create path seeds its four tables inside one transaction, but the tool seed
  issued its insert on a second pooled connection, which cannot see the agent row
  that transaction has not committed, and the insert died on
  `instance_tools_instance_id_fkey`. Every read and write on the create path now
  runs on the caller's transaction. The skill seed carried the same split — it is
  inert on this build, where the default skill list is empty, and is corrected
  with it.

### Changed

- `recomputeInstanceTools` accepts an optional executor. Given one it reuses that
  transaction instead of opening a second; called without one, as the import
  paths do after their own transaction closes, it behaves as before. Internal
  module, not a documented SemVer surface.

## [1.1.0] - 2026-09-04

> **Upgrading from 1.0.0 needs operator action** — this release is not a rolling
> upgrade, is forward-only past migrations `0071` and `0076`, and requires forcing
> every user to sign in again. See
> [docs/UPGRADING.md](https://github.com/polyant-ai/polyant/blob/main/docs/UPGRADING.md).

### Added

- **MCP client**: an agent can equip tools from external Model Context Protocol
  servers, configured per agent, with `none` / `static` / OAuth 2.1 auth modes.
  Credentials are encrypted at rest and never returned by the API. New tunable
  `MCP_CONNECT_TIMEOUT_MS` (default 10000) bounds the per-server connect so one
  slow server cannot stall a turn.
- **A2A server**: an agent can be exposed over the Agent2Agent protocol (Agent
  Card + JSON-RPC). Opt-in per agent, off by default.
- **Tenant-scoped frontend URLs**: admin routes live under the workspace
  segment, `GET /api/me` reports the caller's tenancy, and navigation is
  scope-aware.
- **Every agent section is addressable from the sidebar.** The agent detail page
  dropped its nested tab row: each section is a sidebar row under the same
  headings, and `?tab=` remains the address. Twenty-three destinations became
  eighteen, and the workspace-wide conversations, saved memories and run log
  gained a per-agent view.
- **MCP servers are their own section** (`?tab=mcp`) rather than a block at the
  tail of the Tools page.
- A scheduled task can be created disabled: `POST` accepts `enabled` (default
  `true`), so a schedule can be staged without a window in which it can tick.
- **WhatsApp channels can authenticate with a Twilio API Key** instead of the
  account Auth Token. Twilio signs inbound webhooks with the Auth Token only, so
  a channel in that mode receives messages on a dedicated webhook URL carrying a
  server-generated secret, revealed and rotatable from the admin panel. First
  released in 1.0.1; included here.
- **Retention covers every traffic-driven table.** `tool_audit_logs`,
  `hook_executions`, `scheduled_task_runs` and the completed half of
  `event_backlog` now age out on the same policy as `ai_logs` and
  `pipeline_traces`; the four are also what the heaviest analytics
  aggregations read. Conversation messages, memories and the knowledge tables
  are deliberately excluded — ageing product data out is an operator's
  decision, not a housekeeping job's.
- **A failed provider call is recorded.** A turn that died at the provider
  used to write no `ai_logs` row at all, so an agent with an expired key looked
  exactly like an idle one. Migration `0077` adds `outcome` and `error_kind`,
  classified into a closed set (`auth`, `rate_limit`, `bad_request`,
  `overloaded`, `timeout`, `unknown`); the provider's own message is never
  stored, because it can quote the request and the request is the prompt.
- **The switch that closes an agent's HTTP surface is back in the panel.**
  `authEnabled` defaults off, so a new agent answers `/v1/chat/completions`
  with no credential — the Status page reported this correctly, but the control
  it pointed at had been removed, leaving a hand-written `PATCH` as the only
  way to close an open agent.

### Changed

- **BREAKING — `users.role` is dropped.** Migration `0076` reconciles the flag
  from the role column one final time — any row promoted by a direct `role`
  update that never touched `is_platform_admin` is brought into agreement
  first — then drops the column, so no account silently loses its standing.
  **There is no rollback past this migration**: the column is gone, and older
  code that still selects `role` fails on every read of the users table.
- **BREAKING — `users.is_platform_admin` is the sole authority for
  platform-admin standing**, read from the database on every request instead
  of carried on the session. Promoting or revoking an account now takes
  effect within the platform-admin cache's five-minute window, without
  requiring the account to sign out and back in.
- **BREAKING — `POST`/`PATCH /api/users` take `isPlatformAdmin: boolean`** and
  no longer return `role`. `role` is still accepted on input for one release,
  as a deprecated alias for both legacy spellings (`platform_admin` and
  `superadmin`), and is never persisted or echoed back.
- **BREAKING — RBAC is enforced unconditionally.** The `AUTHZ_ENFORCE`
  environment variable is gone; there is no shadow mode. An undeclared route or
  a failed permission check is a 403 with no way to turn it off. Installations
  that copied the previous sample `.env` were running with every permission
  check reduced to a no-op.
- **BREAKING — `AUTH_MODE=alb-oidc` is not compatible with enforced RBAC.** A
  gateway-forwarded identity carries no organization and holds no role bindings,
  so it is denied on every management route. The engine now refuses the
  combination at boot instead of 403-ing at runtime. Use `AUTH_MODE=session`
  until the gateway-identity mapping exists.
- **BREAKING — membership is granted deliberately, never by signing in.** A new
  user is provisioned with no organization membership; an administrator must
  assign a role before they can reach anything.
- **BREAKING — the platform-admin role value is `platform_admin`** (was
  `superadmin`). Reads accept both spellings; writes emit only the canonical
  value. Migration `0071` rewrites the persisted value. **Forward-only** — see
  the upgrade guide.
- **BREAKING — Member can now configure an agent end to end**, credentials
  included: migration `0072` grants `agent.secret:read`, `agent.secret:write`
  and `agent.export:read` to the Member role in every existing organization.
  Secrets remain write-only through the API (reads return key names only), but
  this is a real privilege expansion applied on upgrade.
- **BREAKING — frontend URLs are tenant-scoped** and the workspace URL segment
  is authoritative. Pre-existing bookmarks to flat paths (`/instances`,
  `/conversations/<id>`, `/playground`, …) and to legacy `?tab=` values no
  longer resolve; navigate from the organization dashboard instead.
- **BREAKING — an empty tool set means no tools.** `instance_tools` holding no
  rows used to be read as "enable everything", so an agent with every switch off
  — or one seeded before the tool catalogue synced — ran with the whole
  registry, `httpRequest` and the file tools included. An agent's tool set is now
  exactly what is stored, on both the runtime and the secret-prompting side.
  **Audit any agent whose tool rows are empty before upgrading**: it loses the
  tools it was silently running.
- **BREAKING — `POSTGRES_SSL` is parsed strictly.** `true` and `false` are the
  only accepted values and anything else — `1`, `TRUE`, `require`, `yes` —
  fails the boot; an empty environment variable now means unset everywhere, for
  every optional variable. The old coercion treated any non-empty value as true,
  so `POSTGRES_SSL=false` switched TLS *on*. This bites before the migrations
  run — audit it first.
- **BREAKING — `GET /api/tools`** now requires `ORG_READ` instead of
  `TOOL_READ`: an agent-scoped principal that could previously list the registry
  now receives 403.
- **BREAKING — `GET /v1/models`** returns an empty list, rather than every
  active agent, for a principal whose organization cannot be resolved. An
  integration that enumerates models to discover a slug sees `[]` instead of an
  error.
- **A new agent's prompt sections are seeded empty.** The seven rows still
  exist, so the panel has somewhere to write; only the default prose is gone, so
  an agent's behaviour no longer comes from text its author never read.
- **Credentials offers every provider**, not just the ones an agent already
  runs on, so a key can be entered before the agent is switched to it. LangSmith
  stays the exception, beside the tracing switch that reveals it.
- Membership grants and revocations, platform-admin bootstrap, and the
  `/api/users` mutations are now recorded in the management write-audit log.
- **The engine runs on AI SDK 7.** `usage` is now the across-steps cumulative
  total, which is what feeds cost estimation and the per-model cache rates, and
  the prompt-cache marker moved onto `instructions` because v7 rejects a
  `system` message inside `messages`. No configuration changes.
- **Outbound HTTP that carries the SSRF-pinned dispatcher goes through one
  place.** The engine moves to undici 8, whose `Agent` Node's bundled fetch
  refuses outright — the three call sites that passed a dispatcher to the global
  fetch would have silently lost DNS pinning.
- The engine lints on ESLint 10; the admin panel stays on 9, which
  `eslint-config-next` still requires. Relative import extensions are enforced
  per package rather than by a repo-wide rule that was half wrong.

### Fixed

- `/v1/chat/completions` reports real token usage instead of zeros.
- The live activity SSE feed is scoped to the caller's organization, and its
  teardown no longer leaks a heartbeat timer plus a bus subscription when the
  connection drops mid-write.
- CodeQL findings closed: log injection, a file-read TOCTOU, and a
  prototype-pollution-prone key write. Third-party actions are pinned.
- **A revoked platform admin kept a full authorization bypass for up to five
  minutes.** The platform-admin cache had a 5-minute TTL and was never
  invalidated; every write of the flag now clears it.
- **A duplicate, undecorated `InstanceSkillsController` is gone.** It served
  `POST`/`DELETE` on `api/instances/:slug/skills` with no authorization
  decorator at all, so under the previous shadow mode any authenticated user
  could enable or disable skills — and with them the tool surface and prompt —
  on any agent.
- Cross-tenant boundaries closed on attachments, agent creation and listing,
  memory writes, agent-to-agent handoffs and the sidebar; the organization
  filter fails closed, a platform admin outranks every organization role, and a
  route whose authorization is not RBAC is no longer denied outright.
- Only one migrator runs at a time (session-level advisory lock), and a journal
  entry that sorts before an already-applied one is no longer skipped in
  silence.
- A hook that ran out of time no longer affects the turn: the deadline aborts a
  signal, late writes are refused by a fenced state view, and a control return
  that arrives post-abort is dropped.
- An MCP server URL is validated when it is dialled, not only when it is saved,
  and an imported server is not treated as a trusted one.
- An A2A task belongs to the agent it was created on, and the JSON-RPC endpoint
  is bounded.
- Enabling a tool the catalogue has lost no longer answers 200 with the change
  undone: the mirror is repaired where registry and catalogue disagree.
- The admin route group serves its own 404, the sidebar stays inside the
  caller's tenant, navigation links no longer misfire while the tenancy loads,
  and an anonymous visitor keeps their query string across the login bounce.
- Resources acquired by the engine are released on every path.
- **An instance bundle can no longer introduce a channel credential.** Import
  strips credential-like keys the way export already did, so a crafted bundle
  cannot arrive carrying a webhook secret and have the channel enabled with it.
- **WhatsApp media downloads only send Twilio credentials to Twilio.** The
  `MediaUrl` on an inbound message is attacker-influenced; the first hop is now
  checked against Twilio's API hosts, regional data-residency hosts included,
  before the Basic credential is sent.
- **A Room event-source webhook token now requires write permission to read.**
  It lets its holder inject events into an agent, so a read-only role could
  previously go from "can look" to "can drive". Its list response no longer
  carries the token; a dedicated endpoint reveals it.
- Credential-bearing webhook paths are redacted before they reach a log line
  even when the path is percent-encoded or differently cased, and
  request-controlled values are stripped of line breaks so they cannot forge
  additional log records.
- `X-Forwarded-Proto` is clamped to `http`/`https` when the webhook URL is
  reconstructed, so a crafted value can neither corrupt the signature check nor
  reach the log.
- **Rotating a WhatsApp inbound secret can no longer be undone by a concurrent
  save.** The carry-forward reads under a row lock inside the same transaction
  as the write; previously a save that started before a rotation could commit
  the old secret back, reviving it while the audit log said it had been retired.
- Destroying a WhatsApp inbound secret is audited, both when a credential-mode
  switch discards it and when the channel is deleted — so the audit trail no
  longer records only the mints and rotations.
- **A throttled route no longer buckets every caller together.** Buckets were
  keyed by `req.ip`, and in the standard topology the panel proxies `/api/*` to
  the engine from one container: five wrong passwords in a minute locked
  sign-in for the whole deployment, while an attacker shared — and hid in — the
  same budget. The bucket is now the account for a credential form and the
  session for an authenticated caller.
- **A prerelease engine version no longer fails every plugin's engine gate.**
  SemVer excludes a prerelease from a range that carries none, so the first
  build tagged with any suffix would have skipped every third-party plugin with
  a warning — boot green, agent silently without its plugin tools and hooks.
  The comparison now reads major, minor and patch and ignores the suffix.
- **`PATCH /api/users/:id` rejects a non-boolean `isPlatformAdmin`** instead of
  coercing it. `"off"` is truthy in JavaScript and false in PostgreSQL, so the
  last-platform-admin guard saw no demotion while the database performed one,
  leaving a deployment with zero platform admins and no way back except SQL.
- **Creating an agent and patching its tool set are each one transaction.** A
  failure between the four writes used to commit an agent with no prompt
  sections or no tool rows — which the runtime reads as "exactly zero tools" —
  and nothing repaired it, while the taken slug answered the operator's retry
  with a 409.
- **Two statements that failed outright above a few hundred agents are gone.**
  The boot-time tool-catalogue sync and agent deletion each bound one parameter
  per row and crossed PostgreSQL's 65 535-parameter limit: the first threw
  inside the boot transaction so the catalogue never synced, the second made a
  channel agent with tens of thousands of conversations undeletable through the
  API.
- The per-turn round trips that built each `ask_<slug>` tool are batched, the
  dashboard aggregation is capped, and migration `0075` indexes conversations by
  `updated_at` so the organization-wide list stops sorting every row the tenant
  owns to return twenty.

### Security

- **Untrusted text is fenced wherever it enters a prompt.** Nonce-tagged
  delimiters existed in one file; the webhook engine's substituted values and
  the channel display name went in plain. A display name carrying a newline and
  a forged closing tag injected instructions at *higher* trust than the user's
  own message, and in the webhook case they persisted into every later turn.
- **A sensitive skill environment variable never reaches the model.**
  `readSkill` — one of two tools enabled by default on every agent —
  interpolated the decrypted value into its result, so the credential entered
  the model's context, the persisted conversation and `tool_audit_logs`. It now
  emits a placeholder that resolves inside the tool call, and the plaintext
  exists nowhere else.
- **One log serializer, and it no longer writes what the policy forbids.** The
  file logger serialized errors with `JSON.stringify`, which drops the
  non-enumerable `message` and `stack` and keeps the custom fields — where pg,
  the AWS SDK and fetch put connection strings, request configs and
  authorization headers. A single provider 401 wrote the upstream bearer token
  and the folded prompt into a log file. Authorization, API-key, token, secret,
  password, credential, connection-string, cookie and private-key fields are now
  redacted at any depth, and tool output is capped rather than copied whole into
  the audit table.

## [1.0.2] - 2026-08-26

### Fixed

- The Speech-to-Text provider setting now accepts an explicit "Disabled" value. An unrecognised or unset provider previously fell back silently to OpenAI Whisper, so an operator who wanted voice messages turned off had no way to say so, and audio replies could fail looking for credentials that were never configured. Choosing "Disabled" now returns a plain "voice messages are not supported" reply instead.

## [1.0.1] - 2026-08-25

> Released from `main` as a hotfix on 1.0.0. Its changes are also present in
> 1.1.0, which carries them forward.

### Added

- WhatsApp channels can authenticate to Twilio with a revocable API Key instead of the account Auth Token. Twilio signs inbound webhooks with the Auth Token only, so an API Key channel receives messages on a dedicated webhook URL carrying a server-generated secret, which can be revealed and rotated from the admin panel.
- The WhatsApp channel has its own configuration card in the admin panel, with a credential-mode selector and the webhook URL to paste into the Twilio Console.

### Changed

- Channel configuration is persisted exactly as its schema validates it, so credentials pasted with surrounding whitespace are trimmed and keys outside the validated shape are no longer stored.
- The management API writes only known channel configuration keys and ignores unrecognised fields in a request body.
- Twilio Account SIDs are validated for format when a WhatsApp channel is saved.

### Security

- Webhook paths that carry a credential are redacted before being written to logs, covering both the WhatsApp inbound webhook secret and the Room event-source webhook token.
- Inbound WhatsApp webhook requests that fail before authentication all return one identical response, so an anonymous caller cannot enumerate agent slugs or determine which credential mode a channel uses.
- Request-controlled values are stripped of line breaks before being written to a log line, so they cannot introduce additional log records.

## [1.0.0] - 2026-08-05

### Added

- First public open-source release of Polyant, with a Supervisor runtime for configurable AI assistants, automatic long-term memory, and multi-channel delivery.
- Telegram, Slack, WhatsApp, webhooks, and an OpenAI-compatible HTTP API, alongside multi-instance administration and conversation inspection.
- Encrypted per-instance secrets, plugins and Markdown skills, Room automation, and runtime analytics.
- Bounded agent-to-agent handoffs, live activity, configurable web search, and structured tool-secret inputs.

### Changed

- Semantic Versioning now defines the public compatibility contract for the documented OpenAI-compatible API, Plugin SDK and manifest, and documented configuration and migration behavior.
- Conversation traces preserve per-step reasoning and tool metadata; incoming message fragments can safely cancel and restart an in-flight run.

### Fixed

- Memory deduplication now honors its configured similarity threshold, and Google OAuth remains optional when its credentials are absent.
- Delegated sub-agents cannot recursively spawn further sub-agents.
- Node.js 22 is aligned across the supported development and container environments.

[Unreleased]: https://github.com/polyant-ai/polyant/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/polyant-ai/polyant/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/polyant-ai/polyant/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/polyant-ai/polyant/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/polyant-ai/polyant/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/polyant-ai/polyant/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/polyant-ai/polyant/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/polyant-ai/polyant/releases/tag/v1.0.0
