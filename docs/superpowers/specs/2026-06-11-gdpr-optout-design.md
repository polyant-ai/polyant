# Design: GDPR Opt-Out ("STOP / START")

- **Status:** Proposal / draft for review (no implementation yet)
- **Date:** 2026-06-11
- **Base:** `polyant-ai/polyant` `develop` (includes conversation state store, hooks, tool-result replay, per-turn debug). All `file:line` references assume that base.
- **Scope:** a per-instance, framework-level mechanism that lets an end user stop receiving any message by sending a keyword (e.g. `STOP`) and resume with a counter-keyword (e.g. `START`). Enforcement is deterministic — never delegated to the LLM.

---

## 1. Summary

Add a **per-instance GDPR opt-out** capability. When an end user sends a configured **stop keyword**, the engine:

1. records the opt-out **persistently, per contact** (`instanceId` + `channelType` + `channelId`), so it survives across all future conversations and Room cycles;
2. sends a configurable **closing message once**;
3. then stays **fully silent** to that contact — both reactive replies **and** proactive sends (Room, scheduled tasks, webhooks, tools) are suppressed — until the user sends a configured **resume keyword**, which re-enables the assistant and sends an optional confirmation.

Enforcement is **deterministic and code-level**, applied at two chokepoints (inbound pre-LLM gate + outbound suppression). The LLM is never the enforcer. The stop keyword is *also* injected into the system prompt as **informational** context (so the agent can tell users how to opt out), but the prompt never gates anything.

This is a **framework, domain-agnostic** capability: keywords, messages, and enablement are per-instance configuration in PostgreSQL — never code.

---

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Enforcement model | **Deterministic code gate** (pre-LLM + outbound). Prompt injection is informational only. |
| Persistence scope | **Per contact, per instance** — `(instanceId, channelType, channelId)`. Survives across conversations and Room cycles. Never conversation-scoped. |
| Behavior after opt-out | **Total silence** until the resume keyword. The LLM is not invoked for silenced messages, and those messages are **not persisted** (data minimization). |
| Keyword matching | **Exact match of the whole message** after `trim().toLowerCase()` against the keyword list. No substring matching (avoids false positives). |
| Channels in scope | **All real end-user channels**: WhatsApp, Telegram, Slack, Web. Synthetic channels (`agent`, `scheduled`, `room`) and auto-tasks are excluded. Note: the `web` channel keys opt-out on the per-request `chat_id`; web clients that do not supply a stable `chat_id` receive an ephemeral id each session, so opt-out is only meaningful for web when a stable `chat_id` is provided — the primary GDPR channels (WhatsApp, Telegram) use stable phone/chat ids and work fully. |
| Admin scope (v1) | **List of opted-out contacts + manual override** (admin can opt a contact out / back in for GDPR requests received off-channel). Every transition is in the audit log. |
| Config storage | **Columns on the `instances` table** (1-to-1 with the instance, consistent with existing flags like `state_in_prompt_enabled`). |
| STOP/START record | **Authoritative trail** = audit log + `contact_optouts` row. **Plus** the STOP/START exchange (user keyword + confirmation) is persisted to the conversation for admin visibility (lightweight: no memory/summary/trace/hooks). Silenced messages are not persisted. |

---

## 3. Data model

### 3.1 New columns on `instances` (`instances/schema.ts`)

| Column | Type | Notes |
|---|---|---|
| `optout_enabled` | `boolean` | default `false` |
| `optout_stop_keywords` | `jsonb` `$type<string[]>` | default `["STOP"]` |
| `optout_resume_keywords` | `jsonb` `$type<string[]>` | default `["START"]` |
| `optout_closing_message` | `text` (nullable) | sent once on opt-out; `null`/empty = no confirmation sent |
| `optout_resume_message` | `text` (nullable) | sent once on resume; `null`/empty = no confirmation sent |
| `optout_inject_prompt_hint` | `boolean` | default `true` — informational prompt section |

Existing per-instance boolean flags live on `instances` (`state_in_prompt_enabled` etc. — `instances/schema.ts`); these follow the same pattern. Keyword lists use `jsonb.$type<string[]>().default(["STOP"])` per the repo's JSONB convention (`.claude/rules/typescript-patterns.md`).

### 3.2 New table `contact_optouts` (new module `optout/optout.schema.ts`)

One row per contact that has *ever* interacted with the opt-out mechanism. Absence of a row = subscribed (default).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `defaultRandom()` |
| `instance_id` | `uuid` FK → `instances.id` | `InstanceUuid`, `onDelete: cascade` |
| `channel_type` | `text` | `whatsapp` \| `telegram` \| `slack` \| `web` |
| `channel_id` | `text` | trusted channel identity (phone / chat id / user id) |
| `status` | `text` | `opted_out` \| `opted_in` |
| `source` | `text` | `user` (keyword) \| `admin` (manual override) — origin of the last transition |
| `created_at` / `updated_at` | `timestamptz` | `withTimezone: true`, `defaultNow()` |

- **Unique** `(instance_id, channel_type, channel_id)` — also the hot lookup index.
- Secondary index `(instance_id, status)` for the admin list query.
- On resume, the row is **not deleted** — `status` flips to `opted_in` (retains transition history + `updated_at`). The admin list filters `status = 'opted_out'`.

> `channel_id` is necessarily stored (it *is* the consent record's subject). It is the authoritative legal record alongside the audit trail.

---

## 4. Opt-out evaluation (pure guard — `optout/optout.guard.ts`)

A pure, fully unit-testable function — no I/O:

```ts
type OptoutAction =
  | { kind: "stop"; reply: string | null }
  | { kind: "resume"; reply: string | null }
  | { kind: "blocked_silent" }
  | { kind: "pass" };

function evaluateOptout(input: {
  config: OptoutConfig;                         // enabled, keyword lists, messages
  currentStatus: "opted_out" | "opted_in";      // "opted_in" if no row exists
  messageText: string;
}): OptoutAction;
```

Logic (precedence matters):

1. `!config.enabled` → `pass`.
2. `normalized = messageText.trim().toLowerCase()`; a keyword matches iff `keyword.trim().toLowerCase() === normalized`.
3. If `currentStatus === "opted_out"`:
   - resume keyword → `{ kind: "resume", reply: resumeMessage }`
   - otherwise (incl. a repeated stop keyword) → `{ kind: "blocked_silent" }` *(idempotent — no duplicate closing message)*
4. If `currentStatus === "opted_in"`:
   - stop keyword → `{ kind: "stop", reply: closingMessage }`
   - otherwise (incl. a resume keyword while already subscribed) → `pass`

Keyword lists are expected to be disjoint; misconfiguration is resolved by the precedence above (resume wins when out, stop wins when in).

---

## 5. Inbound enforcement (reactive)

The gate runs at the **top of `handleMessage` and `handleMessageStream`** (`index.ts:158`, `index.ts:253`), **before** the existing Room/task routing (`index.ts:163–184`) and before `runPipelinePre` — so STOP/START are always honored first and the heavy context prep is skipped for short-circuited turns.

Extracted into the opt-out module as `runOptoutGate(msg)` to keep `index.ts` lean:

```ts
// returns a short-circuit reply, or { proceed: true } to fall through
async function runOptoutGate(msg: IncomingMessage):
  Promise<{ proceed: true } | { proceed: false; reply: string }>;
```

Steps:
1. **Skip** for synthetic channels (`agent` / `scheduled` / `room`) and auto-tasks (`isAutoTask(msg)`) → `{ proceed: true }`.
2. Resolve opt-out config (via `config-resolver`, 30 s cache). If `!enabled` → `{ proceed: true }`.
3. Look up current status (`contact-optouts.store`, short-TTL cache). Run `evaluateOptout`.
4. Dispatch on the action:
   - **`stop`** → persist `opted_out` (store write + audit `optout:stop`), persist the STOP exchange to the conversation (§7), return `{ proceed: false, reply: closingMessage ?? "" }`. **LLM not invoked.**
   - **`resume`** → persist `opted_in` (store write + audit `optout:resume`), persist the START exchange (§7), return `{ proceed: false, reply: resumeMessage ?? "" }`. **LLM not invoked.**
   - **`blocked_silent`** → return `{ proceed: false, reply: "" }`. No persistence, no LLM (data minimization).
   - **`pass`** → `{ proceed: true }`.

`handleMessage` returns `{ text: reply }`. `handleMessageStream` wraps `reply` in a single-chunk stream (reusing the existing `MISSING_KEY_RESPONSE` single-chunk pattern at `index.ts:290–295`). An empty reply (`""`) is the established "no outbound" signal (the Room reply already returns `{ text: "" }` at `index.ts:173`); adapters/coordinator skip empty text.

This gate is **channel-agnostic**: it sits above adapter delivery, so it covers WhatsApp, Telegram, Slack, and Web uniformly.

---

## 6. Outbound suppression (proactive)

All proactive sends flow through **`channelManager.sendOutbound`** (`channel-manager.ts:189`) — verified call sites: Room tool, `send-outbound-message`, `slack-post-message`, `whatsapp-send-message`, scheduler (`scheduler.service.ts:173`), webhook engine (`webhook-engine.ts:194`) — plus **`sendOutboundTemplate`** (`channel-manager.ts:239`) for WhatsApp templates.

Add an opt-out check to **both** methods, before `adapter.sendMessage` / `adapter.sendTemplate`:

```ts
async sendOutbound(slug, channelType, channelId, message,
  opts?: { mediaUrl?: ...; skipOptoutCheck?: boolean }) { ... }
```

- Resolve `slug → InstanceUuid` (`resolveInstanceId`, cached), look up status. If `opted_out` and `!opts?.skipOptoutCheck` → **suppress**: log + audit `optout:suppressed` + (optional) an `outbound suppressed` activity-stream event, then return without sending.
- The **reactive** caller — the `MessageCoordinator` wiring at `channel-manager.ts:73–74` — passes `{ skipOptoutCheck: true }`. This is always safe: the inbound gate (§5) already prevents normal replies to opted-out contacts; the only reactive sends that reach an opted-out contact are the closing/resume confirmations, which must go through. (A `blocked_silent` turn returns `""`, which produces no send regardless.)
- The gate is **naturally scoped**: a `slackPostMessage` to `#general` (not a contact in the table) passes through.
- Web/Slack reactive replies are sent by the adapter directly from the handler return value (they never touch `sendOutbound`), so they are governed solely by the inbound gate — consistent behavior.

---

## 7. Conversation persistence of the STOP/START exchange

For `stop` and `resume` transitions only, persist the user keyword message + the confirmation reply to the conversation, for admin visibility and as supporting evidence. This is a **lightweight** path (a dedicated helper in the opt-out module) that:

- derives `conversationId = {instanceId}:{channelType}:{channelId}` (same scheme as the pipeline, `pipeline.ts`);
- calls the conversation store directly (`ensureConversation` + save user + assistant messages);
- **skips** memory extraction, summary, latency trace, and hooks.

`blocked_silent` turns are **not** persisted (data minimization). The authoritative record remains the `contact_optouts` row + audit log.

---

## 8. Prompt injection (informational only)

When `optout_enabled && optout_inject_prompt_hint`, `buildSupervisorSystemPrompt` (`agents/supervisor/prompt.ts`) renders a small section (same mechanism as `renderConversationStateSection`) telling the agent that the user may stop all messages by sending one of `<stopKeywords>` (and resume with `<resumeKeywords>`), so the agent can communicate this when appropriate. The section explicitly states the agent must **not** attempt to process opt-out itself — it is handled by the system.

Threading: the opt-out config sub-object is added to `InstanceConfig` (§9) and passed through the existing `supervise` / `superviseStream` options (`index.ts:195`, `index.ts:263`), like `stateInPromptEnabled`.

---

## 9. Stores, config resolver, types

New module `packages/engine/src/optout/`:
- `optout.schema.ts` — `contact_optouts` table.
- `optout.types.ts` — `OptoutConfig`, `OptoutStatus`, `OptoutAction`.
- `optout.guard.ts` — pure `evaluateOptout`.
- `contact-optouts.store.ts` — `getStatus`, `setStatus`, `listOptedOut` (paginated), with a short-TTL `TtlCache` keyed `${instanceId}:${channelType}:${channelId}`, invalidated on write (hot path: every inbound + every proactive send).
- `optout-gate.ts` — `runOptoutGate` (§5) + the conversation-persistence helper (§7).
- `index.ts` — barrel.

`config-resolver.ts` gains an `optout` sub-object on `InstanceConfig`:
```ts
optout: {
  enabled: boolean;
  stopKeywords: string[];
  resumeKeywords: string[];
  closingMessage: string | null;
  resumeMessage: string | null;
  injectPromptHint: boolean;
}
```
built from the new instance columns (reuses the existing 30 s cache).

---

## 10. Admin API + Web UI

### 10.1 API
- **Config** reuses the existing instance endpoints — no new endpoint. Add the 6 opt-out fields to the `PATCH /api/instances/:slug` DTO and the `GET` response (`server/instances/instances.controller.ts:166`). Keyword arrays validated with Zod (non-empty strings, deduped).
- **Contacts** — new controller `server/optouts/`:
  - `GET /api/instances/:slug/optouts?status=&page=` — paginated list (default `status=opted_out`).
  - `POST /api/instances/:slug/optouts` — manual opt-out `{ channelType, channelId }` (`source = admin`).
  - `DELETE /api/instances/:slug/optouts/:channelType/:channelId` — manual opt-in (`source = admin`).
- All endpoints are **instance-scoped**: resolve `slug → uuid` and constrain every query by `instance_id` (IDOR-safe, same discipline as event sources). Manual-override inputs validated with Zod.

### 10.2 Web
New **"Privacy"** tab (sibling of Room/Hooks) in the instance admin area (`packages/web`, frontend-design-system):
- Config form: enable toggle, stop/resume keyword editors (tag input), closing/resume message textareas, inject-hint toggle.
- Opted-out contacts table: channel, id, date, source — with per-row "Re-enable" and a "Opt out a contact" action (manual override).
- i18n entries (Italian/English).

---

## 11. Edge cases, security, cascades

- **Cascade:** `contact_optouts` is `onDelete: cascade` with `instances` (dropped on `deleteInstance`). It is **deliberately NOT** part of the `deleteConversation` cascade — deleting a conversation must never re-subscribe a contact (that would be a GDPR violation). This must be asserted by a test.
- **Trusted identity:** `channelType`/`channelId` come from the inbound message (the same trusted channel identity used to seed `_channel`), never from LLM output. Admin-supplied overrides are validated.
- **Idempotency:** repeated STOP while opted-out → `blocked_silent` (no duplicate closing message); repeated START while subscribed → `pass`.
- **Room outbound replies (known v1 limitation):** the gate runs at the top of `handleMessage`, *before* Room/task routing, so a STOP sent on the normal channel is always honored. A STOP sent specifically as a reply to a Room *broadcast* target is an edge case; proactive Room sends to an already-opted-out contact are blocked by §6 regardless. Documented, not handled specially in v1.
- **Data exposure:** audit logs record the transition + channel fields (required for the consent trail); the general pipeline log records only outcome, not message bodies.
- **No new env vars** — all config is per-instance DB state (`config.ts` untouched).

---

## 12. Testing

- **Unit (`optout.guard`):** every branch of `evaluateOptout`; whitespace/case normalization; multi-keyword lists; precedence (resume-while-out, stop-while-in, keyword while disabled).
- **Unit (`contact-optouts.store`):** status default (no row = `opted_in`), set/flip, cache invalidation on write.
- **Integration (inbound):** STOP → row `opted_out` + audit + closing message + LLM not invoked; next normal message → silence (`""`, no persistence, no LLM); START → `opted_in` + resume message + subsequent messages reach the LLM. Exchange persisted to conversation; silenced messages not persisted.
- **Integration (outbound):** proactive `sendOutbound`/`sendOutboundTemplate` suppressed for an opted-out contact; reactive (coordinator, `skipOptoutCheck`) and unrelated targets pass.
- **Integration (admin):** manual opt-out/opt-in via API; instance-scoping (no cross-instance access).
- **Cascade:** `deleteInstance` drops rows; `deleteConversation` preserves them.

---

## 13. Migration notes

Per the repo caveat, `drizzle-kit generate` produces full-schema migrations (no snapshots) — **write the incremental migration by hand**: `ALTER TABLE instances ADD COLUMN ...` ×6 (with defaults) + `CREATE TABLE contact_optouts ...` + unique/secondary indexes. Validate via `npm run db:migrate -w @polyant/engine`.

---

## 14. Out of scope (v1)

Double opt-in, consent expiry, full GDPR data export / right-to-be-forgotten erasure, global cross-instance opt-out, dedicated lifecycle hooks for opt-out transitions, and honoring STOP sent as a reply to a Room broadcast target.
