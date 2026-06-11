# Design: Conversation Lifecycle Hooks (event → action)

- **Status:** Proposal / draft for review (no implementation yet)
- **Date:** 2026-06-10
- **Base:** `polyant-ai/polyant` `develop` (includes the conversation state store, tool-result replay, and per-turn debug capture). All `file:line` references assume that base.
- **Scope of this document:** architecture proposal for a per-instance hook mechanism that runs configured actions (v1: "execute a tool") at fixed conversation lifecycle events.

---

## 1. Summary

Add a **per-instance, database-configured hook system**: when a conversation lifecycle event fires (`conversation_start`, `message_received`, `response_generated`, `response_sent`), the engine executes the actions configured for that event — synchronously, deterministically, observe-only.

The hook entity is an **(event, action)** pair. In v1 the only action type is `tool` (execute a registered tool with statically-configured, template-rendered arguments), but the schema and runner are designed around a **discriminated action union + executor registry**, so future action types (e.g. prompt injection, notifications) are additive — no migration, no runner changes.

This is a **framework-level, domain-agnostic** capability: which tool runs on which event, and with which arguments, is per-instance configuration in PostgreSQL — never code.

Motivating example: on `conversation_start` of a WhatsApp conversation, run `hubspotContact` search with `{{channel.id}}` (the verified phone number) so the contact id lands in the conversation state store before the supervisor's first LLM call — the agent "already knows who it is talking to" without any LLM round-trip.

---

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Events in v1 | `conversation_start`, `message_received` (pre-LLM), `response_generated` (pre-delivery), `response_sent` (post-pipeline) |
| Hook power | **Observe-only.** Hooks never modify the user message, the response text, or the control flow. Context enrichment happens via state-store writes (and optionally `state_in_prompt_enabled`). |
| Parameter binding | **Static config + templates.** Admin configures a JSON args object per hook; `{{path}}` placeholders are resolved against the event payload. No LLM in the loop. |
| Execution semantics | **All synchronous** (awaited by the pipeline), each with a per-hook timeout (default 10 s, cap 30 s). |
| Failure semantics | **Log and continue.** A failing/timed-out hook never blocks the user's reply. Errors go to audit + pipeline log. |
| Activation filters | **None.** A hook fires on every occurrence of its event on the instance (auto-tasks and synthetic channels excluded — see §5). |
| v1 management scope | DB schema + Management API (`/api/instances/:slug/hooks`) + admin UI tab. |
| Extensibility | Hook = (event, **action**). `action_type` + `action_config` columns; v1 implements `tool` only. |
| `response_sent` placement | End of `runPipelinePost` (after state flush + persistence kickoff). Semantics: "response finalized and handed to the channel", **not** "delivered" — adapter-level delivery confirmation is a future evolution. |

---

## 3. Data model

New module `packages/engine/src/hooks/` (schema co-located with the domain, per repo convention).

### 3.1 Table `instance_hooks`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `defaultRandom()` |
| `instance_id` | `uuid` FK → `instances.id` | `InstanceUuid`, `onDelete: cascade` |
| `event` | `text` | `conversation_start` \| `message_received` \| `response_generated` \| `response_sent` |
| `action_type` | `text` | v1: `tool` (enum open for future types) |
| `action_config` | `jsonb` `$type<HookActionConfig>` | for `tool`: `{ toolName: string, args: Record<string, unknown> }` where `args` is the template object |
| `enabled` | `boolean` | default `true` |
| `position` | `integer` | execution order within the same (instance, event); default 0 |
| `timeout_ms` | `integer` | default 10000; validated range 1000–30000 |
| `created_at` / `updated_at` | `timestamptz` | `withTimezone: true` |

Index: `(instance_id, event)` (the hot lookup); `enabled` filtering happens in the query.

### 3.2 TypeScript action model

```ts
type HookEvent =
  | "conversation_start"
  | "message_received"
  | "response_generated"
  | "response_sent";

type HookAction =
  | { type: "tool"; toolName: string; args: Record<string, unknown> };
  // future: | { type: "inject_prompt"; ... } | { type: "notify"; ... }

interface HookActionExecutor {
  execute(action: HookAction, payload: HookEventPayload, ctx: HookRunContext): Promise<void>;
}
```

The runner resolves the executor from a `Map<HookAction["type"], HookActionExecutor>` populated at module load. Adding an action type = new executor file + new enum value + new union member. The runner core, store, API, and pipeline wiring stay untouched.

### 3.3 Store (`hooks.store.ts`)

CRUD keyed by `InstanceUuid`, plus a read path keyed by `InstanceSlug` for the pipeline (resolved once via `resolveInstanceId`). Lookup is cached with a `TtlCache` (30 s, same pattern as `config-resolver.ts`) keyed by `instanceSlug` → all enabled hooks grouped by event; the cache entry is invalidated on any mutation for that instance.

---

## 4. Events and template payloads

Hook args are static JSON with `{{path}}` string placeholders, resolved against the event payload (reuse/extend the webhooks `template-renderer.ts` pattern). Substitution is string-only: a placeholder inside a string is replaced; non-string JSON values pass through verbatim.

Payload fields:

| Field | All events | Notes |
|---|---|---|
| `instance.slug` | ✓ | |
| `conversation.id` | ✓ | |
| `channel.type` | ✓ | e.g. `whatsapp`, `telegram`, `web` |
| `channel.id` | ✓ | verified channel id (phone / chat id) — trusted, server-side |
| `user.name` | ✓ | may be empty |
| `message.text` | ✓ | the current user message (for `conversation_start` it is the first message) |
| `response.text` | `response_generated`, `response_sent` only | the assistant's final text |

Unresolved placeholders render as an empty string and emit a warning in the pipeline log (misconfiguration signal, not an error).

---

## 5. Pipeline integration points and semantics

A single entry point: `await runHooks(event, payload, hookCtx)` called explicitly at four fixed points. No event bus.

| Event | Where | Semantics |
|---|---|---|
| `conversation_start` | `runPipelinePre`, after `preparePipeline` returns, **before** `message_received` | Fires when the turn's loaded history is **empty** (first turn). NOT keyed to `ensureConversation`'s `created` flag: with the MessageCoordinator's cancel-and-restart, an aborted first run creates the conversation row but persists no messages — the `created` flag would fire the hook on the aborted run and never again. "Empty history" makes it abort-safe: the restarted run re-fires (accept-waste on external side effects, same documented trade-off as in-flight tool calls). |
| `message_received` | End of `runPipelinePre`, before `supervise` | Fires on every user turn. Awaited — state writes are visible to the supervisor's tools (and to the prompt when `state_in_prompt_enabled`) in the **same turn**. |
| `response_generated` | Start of `runPipelinePost`, after the abort gate, **before** `stateBuffer.flush()` | Precedes delivery on the sync path (the adapter sends only after `handleMessage` returns). State writes ride the turn's commit-on-success flush. **Streaming caveat:** on the SSE path the text has already streamed to the client; the hook fires at stream completion — degraded semantics, documented. |
| `response_sent` | End of `runPipelinePost`, after flush and `afterResponse` kickoff | Semantics: "response finalized and handed to the channel" — the pipeline never observes physical adapter delivery. State writes by these hooks are applied via a direct, immediate store write (the per-run buffer has already flushed). Adapter-level delivery hooks are a future evolution. |

Shared exclusions and behaviors:

- **Auto-task turns** (Open WebUI title/tag) and **synthetic channels** (`agent`, `scheduled`, `room` — the `INBOUND_SUPPRESSED_CHANNELS` set in `pipeline.ts:38`) do **not** fire hooks, consistent with state seeding and inbound emits.
- **Abort:** if the pipeline's `AbortSignal` fires mid-chain, remaining hooks for that event are skipped. Pre-event hooks that already ran on an aborted run had their state writes discarded with the buffer (commit-on-success) — external side effects may have happened (accept-waste).
- **Context:** the `tool` executor builds the tool via the existing `buildTool(def, ctx)` with the **current turn's `ToolContext`**: `instanceId`, decrypted `secrets`, `audit` (scoped logger), `conversationId`, `apiKeys`, `provider`, and `ctx.state` (the per-run `ConversationStateBuffer`, or a direct-write adapter for `response_sent`).

---

## 6. Runner (`hook-runner.ts`)

For `runHooks(event, payload, hookCtx)`:

1. Load enabled hooks for (instance, event) from the cached store; sort by `position`, ties broken by `created_at` (oldest first).
2. Execute **sequentially** (deterministic order — all-sync was an explicit decision; parallelism can be revisited later).
3. Per hook, dispatch to the action executor. The `tool` executor:
   - Resolves the tool from `getToolRegistry()`. Missing tool → warn + skip.
   - Renders the args template against the payload.
   - Validates rendered args with the tool's Zod schema (`safeParse`). Invalid → warn + skip (never throw).
   - Executes with a timeout (`Promise.race` against `timeout_ms`). The underlying call is not forcibly cancelled on timeout (same accept-waste model as pipeline aborts).
4. Any executor error/timeout → audit log + pipeline log, then **continue** with the next hook.

Audit entries record hook id, event, action type, tool name, success/failure, duration — **never the rendered args values** (PII; same policy as `slackPostMessage` body logging).

**Tool eligibility:** hooks bypass the `instance_tools` enablement gate — that gate scopes what the *LLM* may call; hooks are deterministic admin configuration (precedent: harness tools). The tool must exist in the registry; `metaTool`s (e.g. `spawnTask`) are excluded. Missing required secrets surface as runtime errors (log + continue) and as a misconfiguration badge in the UI.

---

## 7. Management API

`packages/engine/src/server/hooks/` (controller = pure HTTP bridge → `hooks.store.ts`):

- `GET    /api/instances/:slug/hooks` — list (grouped client-side)
- `POST   /api/instances/:slug/hooks` — create
- `PATCH  /api/instances/:slug/hooks/:id` — update (partial: enabled, position, action_config, timeout_ms, event)
- `DELETE /api/instances/:slug/hooks/:id` — delete

All mutations are instance-scoped: `instanceId` in the `WHERE` clause (IDOR-safe, same pattern as event sources). Validation (Zod DTO): event enum, action_type enum, `toolName` present in the registry, `args` is a JSON object, `timeout_ms` within 1000–30000, `position` integer ≥ 0. Auth: standard global `AuthGuard` (admin session), not `@Public()`.

---

## 8. Admin UI (packages/web)

New **"Hooks" tab** on the instance page:

- List grouped by event, each row: action summary (tool name), enabled switch, position controls, edit/delete.
- Create/edit dialog: event select, action-type select (v1: only "Run tool"), tool select (from `GET /api/tools`), JSON args editor with a placeholder reference legend (`{{channel.id}}`, `{{message.text}}`, …), timeout input.
- Misconfiguration badge when the selected tool is missing from the registry or lacks required secrets.
- i18n (Italian/English), shadcn/ui components per the design system skill.

---

## 9. Security

- Hook configuration is admin-only (session-guarded Management API).
- Template values come exclusively from the server-built event payload whitelist — never from LLM output; `channel.id` is the verified, injection-resistant identity (same trust class as the `_channel` state seed).
- Rendered args are validated against the tool's Zod schema before execution.
- Audit logs never contain rendered arg values or message/response bodies.
- Timeout cap (30 s) bounds the worst-case added latency per hook; hooks are sequential, so total worst case = Σ timeouts — the UI surfaces this implicitly by listing per-event hooks together.

---

## 10. Testing

- **Unit** — store CRUD + cache invalidation; template rendering (nested paths, unresolved placeholder → empty + warning, non-string passthrough); runner (position ordering, timeout, error-continue, missing tool skip, invalid args skip, abort mid-chain, metaTool exclusion).
- **Integration** — pipeline wiring: `conversation_start` fires only on empty history (and re-fires after an aborted first run); `message_received` state write visible to a supervisor tool in the same turn; `response_generated` write present in the flushed state; auto-task and synthetic-channel exclusion.
- Coverage target per repo rules (≥ 80 % on new code).

---

## 11. Future evolution (explicitly out of scope for v1)

- New action types (`inject_prompt`, `notify`, sub-agent invocation) via the executor registry.
- Adapter-level delivery confirmation → honest `response_sent` semantics.
- `conversation_idle` event (requires a dedicated scheduler).
- Activation filters (channel type, expression-based conditions).
- Per-hook `blocking: false` (fire-and-forget) and retry policies.

---

## 12. Addendum — per-execution telemetry (`hook_executions`)

Added after the v1 implementation, to make hook runs visible in the conversation UI (audit logs alone are not tied to the conversation timeline).

- **Table `hook_executions`** — slug-keyed telemetry, same trust class as `pipeline_traces`/`tool_audit_logs`: `instance_id`/`conversation_id` as `text`, `hook_id` as a plain `uuid` (intentionally NOT a FK — history outlives the hook), `event`, `action_type`, `tool_name`, `success`, `error`, `duration_ms`, `created_at`. Index on `(conversation_id, created_at)`.
- **Writer** — the runner records every execution (success and failure) fire-and-forget right after the audit log; a failed insert never affects the run.
- **Lifecycle** — dropped by the `deleteConversation` cascade; intentionally preserved on instance deletion (same policy as the other telemetry tables).
- **API** — `GET /api/conversations/:conversationId/hooks?instanceId=…` (conversation-scoped, same IDOR guard as the other conversation endpoints) returns executions in timeline order.
- **UI** — the conversation detail page merges executions with messages into one chronological timeline; each execution renders as a centered pill (event, tool, duration, outcome, error on hover). Executions older than the loaded message pagination window are hidden. Note: a `message_received` execution legitimately precedes its user message row in the timeline (the row is persisted commit-on-success at the end of the turn).
- **Playground** — live rendering via custom SSE events is a future follow-up; the persisted conversation view covers the audit need today.
