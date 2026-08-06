# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed

- **BREAKING — RBAC is enforced unconditionally.** The `AUTHZ_ENFORCE`
  environment variable is gone; there is no shadow mode. An undeclared route or
  a failed permission check is a 403 with no way to turn it off. Installations
  that copied the previous sample `.env` were running with every permission
  check reduced to a no-op.
- **BREAKING — `AUTH_MODE=alb-oidc` is not compatible with enforced RBAC.** A
  gateway-forwarded identity carries no organization and holds no role bindings,
  so it is denied on every management route. Use `AUTH_MODE=session` until the
  gateway-identity mapping exists.
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
- **BREAKING — `GET /api/tools`** now requires `ORG_READ` instead of
  `TOOL_READ`: an agent-scoped principal that could previously list the registry
  now receives 403.
- **BREAKING — `GET /v1/models`** returns an empty list, rather than every
  active agent, for a principal whose organization cannot be resolved. An
  integration that enumerates models to discover a slug sees `[]` instead of an
  error.
- Membership grants and revocations, platform-admin bootstrap, and the
  `/api/users` mutations are now recorded in the management write-audit log.

### Fixed

- `/v1/chat/completions` reports real token usage instead of zeros.
- The live activity SSE feed is scoped to the caller's organization, and its
  teardown no longer leaks a heartbeat timer plus a bus subscription when the
  connection drops mid-write.
- CodeQL findings closed: log injection, a file-read TOCTOU, and a
  prototype-pollution-prone key write.

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

[Unreleased]: https://github.com/polyant-ai/polyant/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/polyant-ai/polyant/releases/tag/v1.0.0
