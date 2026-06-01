# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Per-instance **Thinking** toggle on the Settings tab, gated by model capability (migration `0039_add_thinking_enabled.sql`).
- Live SSE activity feed: `GET /api/activity-stream/live` plus a dedicated sidebar entry in the admin panel; seven dormant emitters wired across pipeline, channels, memory, cron, webhook, and agent-handoff paths.
- Virtual `agent` channel for in-process agent-to-agent invocation: each instance with the channel enabled is exposed to its peers as a synthesized `ask_<slug>` tool. Depth bounded at 1, per-call timeout `AGENT_CALL_TIMEOUT_MS` (default 60s).
- Alphabetical sort on the **Agents** and **Skills** listing pages.
- **Active / All** segmented filter on the agents listing (replaces a non-discoverable status pill).
- Top action-bar **Save** on instance tabs (single sticky button across General/Prompts/Tools/Skills/Settings instead of one button per tab).
- Sticky-sidebar redesign of the **Prompts** tab (stacked sections with anchor navigation).
- `getCompany` HubSpot tool for retrieving company records by ID or domain.
- Multi-provider web-search backend selection (Tavily, SerpAPI, DuckDuckGo) via per-instance secret.
- `RequiredSecretSpec` typed schema (`text` / `select`) for tool secret declarations, enabling structured admin-panel inputs.
- Five new env vars documented on the reference page: `AGENT_CALL_TIMEOUT_MS`, `CORS_ORIGINS`, `NODE_ENV`, `WORKSPACES_ROOT`, `DEBUG_LLM_PAYLOAD`.

### Changed
- Conversation messages schema: column `tool_calls` renamed to `steps`, new `reasoning` column added (migration `0038_reasoning_and_steps.sql`). The AI gateway now buffers per-step reasoning blocks and tool calls and surfaces them on `ChatResponse.steps[]` as `{ text, reasoningBlocks, toolCalls }`.
- Supervisor entry points (`supervise`, `superviseStream`, `handleMessage`, `handleMessageStream`) accept an optional `AbortSignal` propagated end-to-end through the AI gateway and the Vercel AI SDK.
- Inbound message coordinator switched to a cancel-and-restart fragmenting model: a new fragment arriving mid-pipeline aborts the in-flight Supervisor run and re-arms the soft-debounce timer, up to `MESSAGE_MAX_RESTARTS` times.
- `ChannelType` (wide, message-routing) renamed to `MessageChannelType`; the narrow API-surface `ChannelType` tuple is now reserved for admin/channels CRUD.
- Renamed project from "Agent Builder" to **Polyant** for the public open-source release.
- Identifier prefix `AB_*` / `ab-*` renamed to `OA_*` / `oa-*` (env vars, credential files, git helpers).
- Default error messages and prompts translated to English.
- Internal historical planning docs (`docs/plans/`, `docs/superpowers/plans/`) removed.

### Fixed
- `DEDUP_SIMILARITY_THRESHOLD` env var is now actually applied to the memory dedup pass (previously hardcoded to `0.90`).
- Web app no longer crashes at boot when `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are empty — the Google provider is registered only if both are present.
- `spawnTask` infinite-recursion guard: the sub-agent's tool set is now built with `spawnTask` stripped out and the system prompt advertises the restriction (commit `5b1b3a3d`).
- Node version aligned to **22** across `Dockerfile`, `.nvmrc`, README, and `docs/getting-started/install.md`.

### Removed
- Unused `governance` category from the activity-stream module (types, i18n strings, render block, narrative tests) — it was never emitted.
- Stale `hubspot-file.tool.ts` import that slipped into the batch 2 OSS port.

### Added (initial release)
- Initial open-source release
- Multi-agent supervisor with Vercel AI SDK v4
- Long-term memory with pgvector + PostgreSQL FTS hybrid search (RRF fusion)
- Multi-channel support: Telegram, Slack, WhatsApp (Twilio), OpenAI-compatible HTTP API
- Provider-agnostic AI gateway with tier abstraction (`fast | standard | heavy`)
- Self-registering tool system (`*.tool.ts` files auto-discover at boot)
- Skill system with per-instance encrypted environment variables
- Event-driven Room for proactive agent workflows
- Admin panel (Next.js 15) with full instance, conversation, memory, and analytics management
- AES-256-GCM encryption for instance secrets and skill env vars
- Auth.js v5 Google OAuth with JWT/JWE session strategy
- Pipeline latency tracing per request phase
- Inbound message debouncer for WhatsApp/Telegram burst handling
- File attachment support (WhatsApp/Telegram → S3 → multimodal LLM)
- DCO sign-off requirement for all contributions (`git commit -s`)
- GitHub OSS scaffolding (SECURITY.md, issue/PR templates, dependabot, CodeQL, CI workflows)
- Demo instance (`demo-agent`) seeded at first boot for quickstart
