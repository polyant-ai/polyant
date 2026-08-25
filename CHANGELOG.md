# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-08-25

> **Upgrading from 1.0.0 needs operator action** — this release is not a rolling
> upgrade, is forward-only past migration `0071`, and requires forcing every user
> to sign in again. See [docs/UPGRADING.md](docs/UPGRADING.md).

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

### Changed

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
[1.1.0]: https://github.com/polyant-ai/polyant/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/polyant-ai/polyant/releases/tag/v1.0.0
