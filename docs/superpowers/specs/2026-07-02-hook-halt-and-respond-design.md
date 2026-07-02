# Hook halt-and-respond — design

**Date:** 2026-07-02
**Status:** approved (brainstorming)
**Related:** `docs/superpowers/specs/2026-06-10-hook-system-design.md`

## Problem

The conversation lifecycle hook system (`packages/engine/src/hooks/`) is
**observe-only**: `runHooks()` runs the configured tools, captures input/output
for telemetry, swallows every error, and returns `HookExecutionSummary[]`.
Nothing a hook does can affect control flow.

We want a hook to be able to **interrupt the LLM pipeline before the model runs**
and supply a precise, system-authored reply that:

1. is persisted in the conversation history as the assistant message (as if
   LLM-generated), and
2. is delivered to the user,

skipping the supervisor/LLM call entirely for that turn.

## Constraints & framework-first framing

- Polyant is a general-purpose framework. The mechanism must be domain-agnostic:
  the halt **decision logic lives in a tool**, not in framework code or static
  config. There is intentionally no condition engine — the tool *is* the
  condition (business hours, blocklist, human-handoff, compliance, …).
- Opt-in by construction: the feature only activates when an instance configures
  a hook whose tool returns the halt signal. No new per-instance flag.
- Only **pre-LLM events** can halt: `message_received` and `conversation_start`.
  On the post-LLM events (`response_generated`, `response_sent`) the halt signal
  is **ignored** — in streaming the text has already been sent to the client, so
  replacing it is not clean. Documented, no new branch.

## Chosen approach

**Tool-driven halt via a reserved result envelope.** A tool executed by a hook
may include a reserved control key in its returned object; the hook runner
interprets it, stops the hook chain, and the pipeline short-circuits.

Rejected alternatives:
- **Static `respond` action type** — without a condition engine an unconditional
  halt on `message_received` would make the agent mute; useful only for edge
  cases. Not worth a new action type.
- **Both** — extra surface to maintain/test for no proven need (YAGNI).

## The halt contract

```ts
// hooks/hook-types.ts
export const HOOK_HALT_KEY = "__haltPipeline" as const;

export interface HookHaltSignal {
  message: string;
}
```

A tool signals a halt by returning an object that contains the reserved key:

```ts
return { /* normal result fields */, [HOOK_HALT_KEY]: { message: "…" } };
```

- Inert outside hooks: if the LLM calls the same tool, only the hook runner reads
  the key — everywhere else it is an ignored extra field.
- No existing tool sets it → zero behavioural change for current instances.
- The framework provides no built-in "gate" tool; the instance author writes a
  tool (or extends one) whose logic decides when to emit the signal. This is the
  standard tool extension point.

## Data flow (5 minimal touch-points)

1. **`hook-types.ts`** — add `halt?: HookHaltSignal` to both
   `HookExecutionCapture` and `HookExecutionSummary`. Export `HOOK_HALT_KEY` and
   `HookHaltSignal`.

2. **`actions/tool-action.ts`** — after `execute()` returns, if the result is a
   non-null object containing `HOOK_HALT_KEY` with a string `message`, call
   `capture({ halt: { message } })`. The result is still serialized to telemetry
   as today (the envelope shows up there too — acceptable).

3. **`hook-runner.ts`** — in the per-hook loop, after the executor runs, if
   `captured.halt` is set: assign it to the pushed `summary.halt` and **`break`**
   the loop (first halt wins; remaining hooks for this event are skipped). The
   telemetry/audit for the halting hook is recorded normally before the break.
   The function still returns `HookExecutionSummary[]` — no signature change.

4. **`pipeline.ts` → `runPipelinePre`** — after the pre-LLM hooks run, scan
   `hookExecutions` for the first summary with `.halt`; if found, set
   `shortCircuit: { text: halt.message }` on `PipelinePreResult` (new optional
   field). No effect when absent.

5. **`index.ts` handlers:**
   - `handleMessage` — if `pre.shortCircuit`: skip `supervise()`; call
     `runPipelinePost` with `resultText = pre.shortCircuit.text`,
     `usage = { promptTokens: 0, completionTokens: 0 }`, no `steps`,
     `isStreaming: false`; return the finalText.
   - `handleMessageStream` — if `pre.shortCircuit`: return a single-chunk stream
     (same shape used by the opt-out gate and missing-key path) whose `completed`
     promise runs `runPipelinePost` with the canned text. `meta` still carries
     `{ conversationId, messageId }`.

Post-LLM behaviour is unchanged: the canned text goes through
`runPipelinePost` → `afterResponse`, so `response_generated`/`response_sent`
hooks fire, and memory extraction + summary run — a **complete turn**, identical
to an LLM-generated one. It also respects the existing abort/commit-on-success
gate: an aborted run persists nothing.

## Edge cases

- **`conversation_start` halt on turn 1** — valid gate/greeting use case; the
  user + canned assistant message are persisted as a normal first turn.
- **`toolResultsInHistoryEnabled` on** — the halting hook's tool call is
  persisted as a leading step like any pre-LLM hook tool. Harmless.
- **Malformed signal** — if `HOOK_HALT_KEY` is present but `message` is not a
  non-empty string, treat it as *no halt* (log a warning), so a buggy tool never
  produces an empty reply.
- **Halt on a post-LLM event** — ignored (the runner still breaks the chain to
  keep behaviour predictable, but `runPipelinePost` never reads `shortCircuit`).

## Out of scope

- New action types, per-instance feature flag, condition engine.
- Halting/replacing an already-streamed response (post-LLM halt).
- A built-in generic "gate" tool (instances provide their own).

## Verification

A runnable check (assert-based `demo()` or a small `hook-runner` test):

1. A stub executor that emits `capture({ halt: { message: "X" } })` →
   `runHooks` returns a summary with `halt.message === "X"` **and** a second
   hook after it does **not** run.
2. A stub executor with no halt → `runHooks` behaves exactly as today (all hooks
   run, no `halt` on any summary).

Plus updates to existing `hook-runner.test.ts` and, if present, pipeline/handler
tests covering the short-circuit path (sync + streaming).
