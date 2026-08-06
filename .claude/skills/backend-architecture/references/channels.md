# Channels: HTTP, agent-to-agent, adapters, opt-out

Moved out of `CLAUDE.md` verbatim: the invariants stayed there, this is the reasoning
and the detail behind them. Read the entry in CLAUDE.md first — it says what the rule
IS; this file says why, and what breaks when it is ignored.

- **Channel adapters are per-instance**: configs stored encrypted in DB, started/stopped dynamically via admin panel or API

- **Channel boot is fire-and-forget**: `channelManager.startAllForInstance()` is NOT awaited at boot — Slack socket mode can hang and block the entire startup sequence (schedulers, room scheduler). Errors are logged, not thrown

- **GDPR opt-out (STOP/START)**: deterministic keyword gate runs at two chokepoints — a pre-LLM inbound gate at the top of `handleMessage`/`handleMessageStream` (short-circuits opted-out contacts; `runOptoutGate` in `packages/engine/src/optout/optout-gate.ts`) and outbound suppression inside `channelManager.sendOutbound`/`sendOutboundTemplate` (blocks proactive sends, coordinator bypasses with `skipOptoutCheck`). Opt-out state persisted per `(instanceId, channelType, channelId)` in `contact_optouts` table (cascade on instance delete, NOT on conversation delete). Config lives as six columns on `instances` (opt-out enabled, stop/resume keywords, closing/resuming messages, prompt-hint enabled). The LLM is never the enforcer; the keyword is injected into the supervisor prompt purely as informational context. Admin endpoints: `GET/POST/DELETE /api/instances/:slug/optouts`. v1 limitation: STOP as a reply to a Room broadcast is not honored. Spec: `docs/superpowers/specs/2026-06-11-gdpr-optout-design.md`
