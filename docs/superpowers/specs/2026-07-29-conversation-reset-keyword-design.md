# Conversation reset keyword (`RESET`) — design

Date: 2026-07-29
Status: approved, not implemented

## Problem

A conversation id is deterministic: `` `${instanceId}:${msg.channelType}:${msg.channelId}` `` ([`preparePipeline`](../../../packages/engine/src/pipeline.ts)). On WhatsApp the `channelId` is the phone number, so a tester always lands in the same, ever-growing conversation. Colleagues testing an agent from one phone number cannot start from a clean slate: history, summary and conversation state all carry over between test runs.

Today the only way out is the admin panel (`PATCH /api/conversations/:id` to rename, or delete). That requires leaving the chat, having panel access, and knowing the conversation id.

## Goal

Let a tester type one word in the chat to archive the current conversation and continue from an empty one, without leaving the channel.

Non-goals: multi-tenant/per-user conversation splitting, an end-user-facing "new chat" feature, any change to how conversation ids are derived.

## Behaviour

1. The tester sends exactly `RESET` (case-insensitive, whole message).
2. The current conversation is **renamed** to `` `${conversationId}#${5 random digits}` `` — history stays browsable in the panel under the suffixed id.
3. The agent replies with a short echo (e.g. `RESET → #48213`).
4. The RESET turn itself is **not persisted** — neither in the archived conversation nor in the new one.
5. The next inbound message re-creates the canonical id as a brand-new, empty conversation (`ensureConversation` in `preparePipeline`).

Archive, never delete: nothing is lost, and deleting is still one click in the panel.

## Architecture

Three existing mechanisms carry the feature; one small addition makes the RESET turn ephemeral.

### Reuse

- **`conversationStore.renameConversation(oldId, newId, title?)`** (`conversations/store.ts`) already moves the text key across every linked table in one transaction: `conversation_messages`, `ai_logs`, `pipeline_traces`, `tool_audit_logs`, `hook_executions`, `memories.source_conversation_id`, and `conversation_state.scope_key`. Because `conversation_state` moves too, the fresh conversation starts with empty state — exactly what a test run wants.
- **Conversation lifecycle hooks** give a deterministic, per-instance, pre-LLM extension point: a `message_received` hook returning `halt` skips the LLM and delivers its own message. Enablement is DB config (Hooks tab), so no instance pays for a hook it has not enabled.
- **`GET /api/hook-functions`** already exposes the hook-function catalog to the web, so the new function shows up in the Hooks tab with no frontend change.

### 1. SDK: `halt.persist`

`HookResult["halt"]` gains an optional field:

```ts
halt?: { message: string; persist?: boolean };
```

`persist` defaults to `true` (current behaviour), so the change is backwards compatible and no existing hook is affected. `HookResult` lives in the external SDK repo (`polyant-ai/polyant-sdk`), so this needs an SDK release (`v1.5.0`), a pin bump in `packages/engine/package.json` (currently `#v1.4.0`), and a lockfile realign.

The flag is generic, not reset-specific: any command-style hook (`/help`, `/whoami`) wants its turn kept out of the model's history.

### 2. Engine: honour `persist: false` on the halt path

- `PipelinePreResult.shortCircuit` becomes `{ text: string; persist: boolean }` (`pipeline.ts`), populated from the halt in `runPipelinePre`.
- Both halt call sites thread it into `runPipelinePost`: the buffered path (`runBufferedTurn` in `index.ts`) and the streaming path (`handleMessageStream` in `index.ts`).
- `PipelinePostOptions` gains `persist?: boolean`. With `const persist = opts.persist !== false;`, `runPipelinePost` skips **only the persistence side effects** when it is false:
  - `traceStore.record(...)` (the `pipeline_traces` row),
  - both `ctx.stateBuffer.flush()` calls,
  - `afterResponse({...})` (user + assistant message rows, summary update, memory extraction, debug payload),
  - `conversationStore.clearContextPrompt(...)` (a write, and a no-op after the rename anyway).

What still runs: the `response_generated` and `response_sent` hooks, `hook_executions` telemetry, `pipelineLog.response`, and returning `finalText` to the channel. A hook execution happened and must stay visible in the panel; only the *turn* is ephemeral.

This composes with the existing abort gate at the top of `runPipelinePost`, which already returns early on an aborted signal — `persist: false` is the same class of "leave no DB trace" decision, taken by the hook instead of the coordinator.

### 3. First-party hook function `conversation-reset.hook.ts`

Lands in `packages/engine/src/hooks/functions/` (empty today — this is the first first-party hook function; the loader already scans the dir). Registered on `message_received`.

```
if (text.trim().toUpperCase() !== "RESET") return;          // normal turn
```

Otherwise: pick an archive id, rename, halt.

- **Keyword is hardcoded** (`RESET`). No secret, no config: `action_config` carries only `functionName`, and a parametric hook config is a separate, larger change (see Alternatives). False positives only matter where the hook is enabled — test instances.
- **Match is exact** on the trimmed, upper-cased whole message, mirroring the GDPR opt-out gate (`optout/optout-gate.ts`), which is the established precedent for a deterministic keyword gate.
- **Id collision**: check `getConversation(target)` first; on collision regenerate once, then fall back to `` `#${Date.now()}` ``.
- **Rename failure**: caught and logged; the halt then replies `RESET failed` instead of claiming success. Never fail silently.
- **Import boundary**: the function imports `conversationStore` from the engine. Legitimate for an in-tree first-party hook, but it makes this function non-portable as an external plugin. A comment records the upgrade path: if an external plugin ever needs reset, expose it as a method on `ctx.conversation` in the SDK.

The echo message is a fixed English string with the archive suffix; not configurable (see Alternatives).

## Configuration

Enabled per instance from the web Hooks tab: event `message_received`, action `function`, `functionName: "conversation-reset"`. No migration, no new endpoint, no frontend change, no new env var.

Channel-agnostic: it behaves identically on WhatsApp, Telegram, web and the playground.

## Testing

- Hook function unit tests: non-match returns `undefined`; exact match calls `renameConversation` with a `#NNNNN`-suffixed id and returns `halt` with `persist: false`; collision path picks a different id; rename failure yields the failure message and still halts.
- Pipeline test: `runPipelinePost` with `persist: false` records no trace, does not flush the state buffer, and does not call `afterResponse`, while still running `response_sent` hooks and returning `finalText`.
- Pipeline test: the default (`persist` absent) path is unchanged — guards the backwards compatibility of the SDK flag.

## Caveats

- **Fragment bursts**: on WhatsApp/Telegram the `MessageCoordinator` concatenates a burst into one pipeline run, so `RESET` followed immediately by more text arrives as `"RESET\n<more>"` and the exact match does not fire. Accepted: send `RESET` on its own.
- **Panel noise**: archived conversations accumulate in the conversation list under suffixed ids. That is the point of archiving rather than deleting, but a heavily-tested instance will collect rows.
- **No undo**: the rename is not reversible from the chat. The panel can rename it back (`PATCH /api/conversations/:id`).

## Alternatives considered

- **Delete instead of rename** — clean list, but test history is gone. Rejected: deleting is still available from the panel.
- **Keyword from a per-instance secret** (`conversation_reset_keyword`, read from `ctx.secrets`) — rejected as unnecessary for a test affordance; hardcoding is one fewer moving part.
- **Parametric hook config** (`action_config.config` → `ctx.config`, plus SDK types, validator and a Hooks-tab form field) — the right move once a second parametric hook exists; deferred until then, and the keyword can migrate into it.
- **Instance columns + a deterministic gate next to `runOptoutGate`** (mirroring the GDPR opt-out: migration, web toggle, export bundle) — ~8 files for a testing convenience. Rejected.
- **A `resetConversation` LLM tool** — non-deterministic (the model decides), which defeats the purpose.
- **Rename in `response_sent`** so the RESET turn lands in the archived conversation — rejected: `afterResponse` is fire-and-forget, so the rename would race message persistence and be flaky.
- **Rename in `message_received` without `halt.persist`** — deterministic, zero engine change, but the RESET turn ends up as the first two messages of the fresh conversation, feeding its history and summary. Rejected in favour of the SDK flag, which is reusable.
