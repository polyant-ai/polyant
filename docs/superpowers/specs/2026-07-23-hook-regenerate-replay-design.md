# Hook `regenerate` — LLM turn replay — design

**Date:** 2026-07-23
**Status:** approved (brainstorming) — implementation pending
**Related:** `docs/superpowers/specs/2026-06-10-hook-system-design.md`, `docs/superpowers/specs/2026-07-02-hook-halt-and-respond-design.md`, `docs/superpowers/specs/2026-07-03-hook-functions-design.md`

## 1. Problem

A `response_generated` hook can today observe the LLM output and, with
`mutatesResponse: true`, **replace** it with a hook-authored string
(`replaceResponse`). What it cannot do is ask the infrastructure to **re-run the
same LLM turn** — the real supervisor call, with the instance's system prompt
and tools — and get a fresh output.

Some provider/model combinations occasionally emit corrupted output (garbled
characters that can't be cleaned, wrong language, values that must not leak,
etc.). Cleaning is not always possible; the only reliable mitigation is to
throw the output away and generate it again. `ctx.ai.chat(...)` is not a
substitute — it is a bare service call with **no** instance system prompt and
**no** tools, so it does not reproduce the turn.

We want the framework to offer a generic verb — **`regenerate`** (a "replay" of
the turn) — that a `response_generated` hook can request *for any reason*. The
**decision** (whether and when to replay) is entirely the hook's business; the
infrastructure only provides the verb and a safety net.

## 2. What the infrastructure must offer

1. A new `HookResult` control return, `regenerate`, honored only on
   `response_generated` and only when the hook declares `mutatesResponse: true`
   (same gate as `replaceResponse`).
2. A way for the hook to know **how many times the turn has already been
   regenerated**, so the hook — not the framework — owns the stop condition
   (Approach A, chosen below).
3. A hard safety cap in the engine that bounds the loop against a buggy hook
   that always returns `regenerate` (runaway-token protection only — not
   product logic).

## 3. Existing hook capabilities (recap)

Four lifecycle events (`conversation_start`, `message_received` — pre-LLM;
`response_generated`, `response_sent` — post-LLM). A hook returns a `HookResult`:
`void` (observe), `halt` (pre-LLM), `injectContext` (pre-LLM), `replaceResponse`
(`response_generated`, requires `mutatesResponse: true`). `mutatesResponse: true`
makes the streaming handler serve the turn **non-streamed** via `runBufferedTurn`
(declare-and-buffer) so a post-LLM mutation lands before any token is sent.

Architectural fact that drives the design: `response_generated` hooks run
**inside** `runPipelinePost` (`packages/engine/src/pipeline.ts`), which
immediately persists the turn. The actual generation (`supervise(...)`) happens
one level up, in `runBufferedTurn` (`packages/engine/src/index.ts`). A replay
loop must therefore live in the caller, **before** persistence — which means the
`response_generated` hook execution has to be extracted out of `runPipelinePost`.

## 4. Chosen approach — Approach A (hook-controlled stop condition)

The engine exposes the running regeneration count to the hook; the hook reads it
and decides whether to ask for another replay. The engine keeps only a high hard
cap as anti-infinite-loop protection.

Rejected — **Approach B** (fixed cap in the engine, `regenerate: true` boolean):
the hook never learns which attempt it is on, so it cannot implement
"regenerate while attempts remain, then give up with a fallback message". It
contradicts the requirement that the stop condition is the hook's logic.

Rejected — **hook does it all via `ctx.ai.chat` + `replaceResponse`**: the bare
service call has no instance system prompt and no tools, so it does not reproduce
the turn — not a real replay.

## 5. Contract (SDK — `polyant-sdk`, shipped as tag `v1.4.0`)

```ts
// HookResult — new control return (twin of replaceResponse)
{ regenerate?: { reason?: string } }   // response_generated only; honored only if mutatesResponse:true

// HookEventPayload.response — expose the counter to the hook
response?: { text: string; regenerationCount: number }   // 0 on the first pass
```

`regenerationCount` is how the hook owns the cap (Approach A): it reads the
number and decides to request `regenerate` again, or to stop (return `void` to
let the output through, or `replaceResponse` with a fallback).

Engine mirrors to update in lockstep (`packages/engine/src/hooks/hook-types.ts`
re-declares these): `HookEventPayload.response`, plus `regenerate?` on
`HookExecutionSummary` and `HookExecutionCapture`. Add a `HookRegenerateSignal`
type mirroring `HookReplaceSignal`.

Example hook (author-side, illustrative):

```ts
export default defineHook({
  name: "dirty-output-guard",
  mutatesResponse: true,
  handler: (ctx) => {
    const { text, regenerationCount } = ctx.payload.response!;
    if (!isDirty(text)) return;                                  // observe: let it through
    if (regenerationCount < 2) return { regenerate: { reason: "dirty output" } };
    return { replaceResponse: { message: "Sorry, please try again." } }; // gave up
  },
});
```

## 6. Engine changes

### 6.1 Extract `response_generated` execution (`pipeline.ts`)

New helper, the single place that runs and interprets `response_generated`
hooks:

```ts
runResponseGeneratedHooks(ctx, messageText, responseText, regenerationCount, abortSignal)
  → { summaries: HookExecutionSummary[]; replace?: HookReplaceSignal; regenerate?: HookRegenerateSignal }
```

Add `firstRegenerate(summaries)` next to the existing `firstReplaceResponse`.

### 6.2 Replay loop (`index.ts`, `runBufferedTurn`)

```ts
let regen = 0;
let result = await supervise(/* … */);
let rg;
while (true) {
  rg = await runResponseGeneratedHooks(ctx, messageText, result.text, regen, abortSignal);
  if (rg.regenerate && regen < MAX_REGENERATIONS) {
    regen++;
    result = await supervise(/* … same args … */);
    continue;
  }
  break;
}
const finalText = rg.replace?.message ?? result.text;
await runPipelinePost({ /* … */ resultText: finalText, responseGenerated: rg });
```

The user/assistant rows are persisted only once, after the loop settles —
consistent with the existing commit-on-success / abort gate (aborted runs leave
no DB trace; the abort signal is checked between passes).

### 6.3 `runPipelinePost` — optional pre-computed hooks

Add optional `responseGenerated?: { summaries; replace? }` to
`PipelinePostOptions`. When present (buffered path — already run in the loop),
`runPipelinePost` does **not** re-run `response_generated` hooks and uses the
supplied `summaries`/`replace`. When absent (streaming path and pre-LLM-halt
short-circuit path), it runs them itself with `regenerationCount = 0`, exactly as
today. One optional parameter, no duplicated logic, backward-compatible with
every other caller of `runPipelinePost`.

## 7. Precedence — `regenerate` vs `replaceResponse`

Within one pass, after all hooks have run in `position` order: if **any** hook
returned `regenerate`, it wins (the turn is regenerated; that pass's `replace` is
discarded because it is re-evaluated against the fresh output). `replaceResponse`
is applied only on a pass where **no** hook asked to regenerate. This is what
enables the "regenerate while attempts remain, then replace with a fallback"
pattern.

## 8. Gate and scope

- **`mutatesResponse: true` required** for `regenerate`, same as `replaceResponse`.
  It reuses `hasResponseMutatingHook`, which already routes the turn through
  `runBufferedTurn` (non-streamed). A `regenerate` returned without
  `mutatesResponse` is ignored with a warning (mirrors the existing
  `replaceResponse` handling in `hooks/actions/function-action.ts`).
- **v1 scope**: only the buffered conversational path (Telegram / WhatsApp /
  Slack / Web / `/v1`). Room and Webhook engines call `supervise()` directly and
  wire only `message_received`, so they run no `response_generated` hook and
  therefore no replay — identical to the current limitation of `replaceResponse`.
- **Pure streaming path** (instance with no `mutatesResponse` hook) and
  **pre-LLM halt path**: `regenerate` is ignored with a warning (no LLM turn to
  replay). Consequence, confirmed with the requester: to get replay the author
  **must** declare `mutatesResponse: true` and accept a non-streamed turn.

## 9. Safety hard cap

```ts
const MAX_REGENERATIONS = 5; // ponytail: engine safety net, not product logic; make per-instance if a real case needs it
```

Beyond the cap the engine ignores further `regenerate` requests, delivers the
last output, and logs a warning. This is protection against a runaway hook, not
the product-level stop condition (§4/§5 own that).

## 10. Telemetry and cost

- Every `supervise()` call — including discarded regenerations — is **already**
  logged to `ai_logs` by the ai-gateway, so the true cost is tracked with no new
  wiring.
- Every `response_generated` hook pass is already recorded in `hook_executions`
  by `runHooks` (fire-and-forget).
- `pipeline_traces` stays one row per turn (the last generation's timing/usage) +
  a `regenerated turn (reason, attempt=N)` log line. No new DB column in v1.

## 11. Testing

- `runResponseGeneratedHooks`: interprets `regenerate` / `replace`, and the §7
  precedence.
- `runBufferedTurn` loop: regenerates on request, stops when no hook asks,
  respects `MAX_REGENERATIONS`, honors the abort signal between passes, persists
  exactly once.
- `function-action`: captures `regenerate` only with `mutatesResponse: true`,
  warns otherwise.
- SDK: `defineHook` accepts the new return shape; `regenerationCount` present on
  the payload.

## 12. Delivery sequence

1. `polyant-sdk`: add the contract (§5), bump to `1.4.0`, tag `v1.4.0`, push.
2. `packages/engine/package.json`: repoint `@polyant-ai/plugin-sdk` git dep to
   `#v1.4.0`, `npm install`.
3. Engine: mirrors (§5) + helper/loop/`runPipelinePost` changes (§6) +
   `function-action` capture (§8) + tests (§11).

## 13. Out of scope (v1)

- Replay on Room / Webhook engines (supervise-direct — §8).
- Replay on streamed turns without `mutatesResponse` (§8).
- Per-instance configurable cap (§9).
- Per-regeneration trace rows / cost aggregation in `pipeline_traces` (§10).
