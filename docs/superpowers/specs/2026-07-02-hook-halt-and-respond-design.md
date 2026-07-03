# Hook halt-and-respond — design

**Date:** 2026-07-02
**Status:** approved (brainstorming) — **implementation deferred to the SDK merge** (see §8)
**Related:** `docs/superpowers/specs/2026-06-10-hook-system-design.md`

## 1. Problem

The conversation lifecycle hook system (`packages/engine/src/hooks/`) is
**observe-only**: `runHooks()` runs the configured tools, captures input/output
for telemetry, swallows every error, and returns `HookExecutionSummary[]`.
Nothing a hook does can affect control flow.

We want a hook to **interrupt the pipeline before the model runs** and supply a
precise, system-authored reply that:

1. is persisted in the conversation history as the assistant message (as if
   LLM-generated), and
2. is delivered to the user,

skipping the supervisor/LLM call entirely for that turn — across **every** flow
that reaches the LLM.

## 2. Scope — every LLM entry point

Architectural fact: `runHooks` runs **only** inside `runPipelinePre/Post`, which
run **only** inside `handleMessage`/`handleMessageStream`. And `buildHookPayload`
suppresses hooks for the synthetic channels `{agent, scheduled, room}`. So today
hooks fire only for real user channels; Room and Webhook call `supervise()`
directly and never run hooks at all.

The user requested halt-and-respond on **all** flows. Two code paths result:

| Flow | Reaches LLM via | Hooks today | Path |
|---|---|---|---|
| Telegram / WhatsApp / Slack / Web / `/v1` | `handleMessage`/`Stream` | ✅ | **A** |
| Scheduled task | `handleMessage` (channel `scheduled`) | ❌ suppressed | **A** (un-suppress) |
| Agent-call (`spawnTask`) | `handleMessage` (channel `agent`) | ❌ suppressed | **A** (un-suppress) |
| Room cycle | `supervise()` direct (`room-engine`) | ❌ none | **B** (wire) |
| Webhook trigger | `supervise()` direct (`webhook-engine`) | ❌ none | **B** (wire) |

Auto-task turns (Open WebUI title/summary) stay excluded via the existing
`isAutoTaskTurn` gate — never in scope.

## 3. Chosen approach — tool-driven halt

The halt **decision lives in a tool**, not in framework code or static config
(framework-first; there is intentionally no condition engine — the tool *is* the
condition: business hours, blocklist, human-handoff, compliance…). A tool
executed by a hook may include a reserved control key in its returned object;
the hook runner interprets it, stops the hook chain, and the pipeline
short-circuits.

Rejected: a static `respond` action type (an unconditional halt on
`message_received` mutes the agent — useful only for edge cases; not worth a new
action type).

## 4. The halt contract

```ts
export const HOOK_HALT_KEY = "__haltPipeline" as const;
export interface HookHaltSignal { message: string; }
```

A tool signals a halt by returning an object containing the reserved key:

```ts
return { /* normal result fields */, [HOOK_HALT_KEY]: { message: "…" } };
```

- **Contract-agnostic.** The hook executor reads `result?.[HOOK_HALT_KEY]` from
  an `unknown` result. This works identically under the current tool contract
  (`def.create() → {parameters, execute}`) and under the SDK's serialized
  contract (`def.execute(input, ctx)` returning arbitrary values). No result
  envelope is assumed.
- **Inert outside hooks.** If the LLM calls the same tool, only the hook runner
  reads the key — everywhere else it is an ignored extra field.
- **Zero regression.** No existing tool sets it.
- **Where it lives:** on `develop` today it would live in engine
  (`hooks/hook-types.ts`). Post-SDK it belongs in `@polyant-ai/plugin-sdk` so
  external plugin authors can import it (see §8). Since implementation is
  deferred to the SDK merge, **define it in the SDK from the start**.

## 5. Path A — `handleMessage` / `handleMessageStream`

### 5.1 Un-suppress synthetic channels for hooks

`buildHookPayload` (`pipeline.ts`) currently returns `undefined` for
`{agent, scheduled, room}`. Drop the `INBOUND_SUPPRESSED_CHANNELS` check there
(keep the `isAutoTaskTurn` + `channelIdentity` guards). `room` never reaches
`handleMessage` (its cycles are supervise-direct), so in practice this enables
hooks for **scheduled** and **agent-call**.

- Keep `INBOUND_SUPPRESSED_CHANNELS` for its other two uses (activity-stream
  `created`/`inbound` emits, and the `_channel` state seed) — those concern
  channel identity / activity feed, not hooks. Introduce a dedicated, narrower
  predicate for the hook gate rather than overloading the shared set.
- **Behaviour change (call out in review):** this enables the *full* hook
  lifecycle (`conversation_start`, `message_received`, `response_generated`,
  `response_sent`) for scheduled tasks and sub-agent calls, not just halt. An
  instance with existing hooks configured will start seeing them fire on those
  flows. Intentional (consistent, no halt-only asymmetry) and documented.

### 5.2 Short-circuit

Threading, minimal touch-points:

1. **`hook-types.ts`** — add `halt?: HookHaltSignal` to `HookExecutionCapture`
   and `HookExecutionSummary`.
2. **tool-action executor** — after the tool runs, if the result is a non-null
   object with `HOOK_HALT_KEY` carrying a non-empty string `message`, call
   `capture({ halt: { message } })`. (Malformed → no halt, log a warning, so a
   buggy tool never yields an empty reply.)
3. **`hook-runner.ts`** — in the loop, if `captured.halt` is set: assign it to
   the pushed `summary.halt` and **`break`** (first halt wins; telemetry/audit
   for the halting hook still recorded before the break). No signature change.
   Add a tiny `firstHalt(summaries): HookHaltSignal | undefined` helper.
4. **`runPipelinePre`** — after the pre-LLM hooks, `shortCircuit =
   firstHalt(hookExecutions)`; add optional `shortCircuit?: { text: string }` to
   `PipelinePreResult`.
5. **`index.ts` handlers:**
   - `handleMessage` — if `pre.shortCircuit`: skip `supervise()`; call
     `runPipelinePost` with `resultText = pre.shortCircuit.text`, zeroed `usage`,
     no `steps`, `isStreaming: false`; return the finalText.
   - `handleMessageStream` — if `pre.shortCircuit`: return a single-chunk stream
     (the shape already used by the opt-out gate and missing-key path) whose
     `completed` runs `runPipelinePost` with the canned text; `meta` still
     carries `{ conversationId, messageId }`.

The canned text flows through `runPipelinePost` → `afterResponse`, so it is
persisted as the assistant message, delivered, respects the
abort/commit-on-success gate (aborted run persists nothing), and — per the
approved "complete turn" choice — `response_generated`/`response_sent` fire and
memory/summary run, identical to an LLM-generated turn.

## 6. Path B — Room & Webhook engines (supervise-direct)

Both engines build no `PipelineContext`; wire the pre-LLM hook manually right
before their `supervise()` call.

- Build a `HookEventPayload` locally:
  - **Room:** `channel = { type: room.outboundChannel ?? "room",
    id: room.outboundTarget ?? "" }`, `user.name = "room"`,
    `message.text = <synthetic events digest>`.
  - **Webhook:** `channel = { type: definition.outboundChannel ?? "webhook",
    id: renderedTarget ?? "" }`, `user.name = definition.name`,
    `message.text = <synthetic trigger message>`.
- Build a `HookRunContext`: `instanceId`, `conversationId`,
  `secrets/apiKeys/provider` from `instanceConfig`; `state = stateBuffer.api()`
  for webhook, `undefined` for room (room has no state buffer — a fresh
  conversation per cycle, no prior state).
- `const halt = firstHalt(await runHooks("message_received", payload, ctx))`.
  - If `halt`: skip `supervise()`, set `finalText = halt.message`, then run each
    engine's **existing** downstream path (persist assistant message with empty
    steps; Room marks events completed; Webhook clears trigger context; both send
    outbound + flush state). Cleanest via a synthetic
    `result = { text: halt.message }` falling through the existing code
    (Webhook's `replyHandled` is falsy → `finalText = result.text`).
  - Else: `supervise()` as today.

**Only `message_received` fires in Room/Webhook** (the pre-LLM, halt-capable
event). The full 4-event lifecycle in these non-conversational flows is a
separate, larger feature (post-LLM hooks over synthetic event digests) and is
out of scope here. Rationale for the asymmetry vs Path A: Path A already owns the
full lifecycle machinery (`runPipelinePre/Post`); Path B has none, and wiring
only the halt path is the scoped change. Documented.

## 7. Edge cases

- **`conversation_start` halt (Path A)** — valid gate/greeting on the first
  persisted turn; user + canned assistant persisted as a normal first turn.
- **`toolResultsInHistoryEnabled` on** — the halting hook's tool call persists as
  a leading step like any pre-LLM hook tool. Harmless.
- **Malformed signal** — `HOOK_HALT_KEY` present but `message` not a non-empty
  string → treated as no halt (warn).
- **Post-LLM event returns halt** — ignored (`runPipelinePost` never reads
  `shortCircuit`); the runner still breaks the chain for predictability.

## 8. SDK interaction & branching (`@polyant-ai/plugin-sdk`)

The branch `feat/tool-serialized-plugins` introduces the plugin SDK
(`git+https://github.com/polyant-ai/polyant-sdk.git`) and rewrites the tool
contract: `def.create(ctx) → {parameters: Zod, execute}` becomes
`def.execute(input, ctx)` with `def.inputSchema` (JSON Schema); tools are
authored via `defineTool` and are externally discoverable. It touches ~100 files
including `hooks/actions/tool-action.ts` — the exact executor this feature edits.

**Decision: implementation is deferred until the SDK lands in `develop`** (the
SDK merge is imminent). Consequences baked into this spec:

- **Implement against the new contract:** read the halt from
  `const result = await def.execute(input, toolCtx)` (not the old
  `create()/execute`). The read is contract-agnostic (§4), so only the insertion
  line differs.
- **`HOOK_HALT_KEY` + `HookHaltSignal` live in the SDK**, exported alongside
  `defineTool`, so first-party *and* external plugin tools import one contract.
  Engine re-exports for internal importers if convenient.
- **Merge-conflict surface is otherwise tiny:** apart from `tool-action.ts`,
  none of this feature's files (`hook-runner.ts`, `hook-types.ts`, `pipeline.ts`,
  `index.ts`, `room-engine.ts`, `webhook-engine.ts`) are touched by the SDK
  branch. Tests must stub tools in the **new** `defineTool` shape.
- **Trust / security:** a discoverable third-party tool that can halt the
  pipeline and inject a system message is bounded by the existing hook trust
  model — hooks are **admin-configured** and bypass `instance_tools`, so a
  discovered tool can halt **only if an admin explicitly wires it into a hook**.
  No new trust hole; documented. (A future SDK could let a tool *declare*
  halt-capability for extra clarity — gold-plating for v1.)

## 9. Out of scope

- Full 4-event hook lifecycle in Room/Webhook (only `message_received` there).
- Halting/replacing an already-streamed response (post-LLM halt).
- A static `respond` action type; a condition engine; a built-in gate tool.
- A tool-declared halt-capability flag in the SDK.

## 10. Verification

- **`runHooks`:** a stub tool emitting `capture({ halt: { message: "X" } })`
  makes `runHooks` return a summary with `halt.message === "X"` **and** a hook
  positioned after it does **not** run. A stub with no halt → behaves exactly as
  today (all hooks run, no `halt`).
- **Path A:** `handleMessage` short-circuits (no `supervise` call) and persists
  the canned text as the assistant message; streaming path emits a single chunk
  and persists on `completed`. Scheduled + agent-call now run hooks
  (un-suppression) — cover with a test.
- **Path B:** Room and Webhook engines short-circuit on halt (no `supervise`),
  persist the canned assistant message, and send it outbound.
- All stubs authored in the SDK's `defineTool` shape (implementation is
  post-merge).
