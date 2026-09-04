# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/polyant-ai/polyant/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/polyant-ai/polyant/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/polyant-ai/polyant/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/polyant-ai/polyant/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/polyant-ai/polyant/releases/tag/v1.0.0
