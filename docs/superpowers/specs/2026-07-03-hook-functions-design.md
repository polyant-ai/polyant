# Hook functions — design

**Date:** 2026-07-03
**Status:** approved (brainstorming)
**Supersedes the hook action model of:** `docs/superpowers/specs/2026-06-10-hook-system-design.md` (tool action) and the tool-side halt of `docs/superpowers/specs/2026-07-02-hook-halt-and-respond-design.md` (PR #158, now in develop)

## 1. Problem

Today a hook's only action type is `tool`: it runs a registered tool with
template-rendered args. This conflates two different things — **tools** (LLM-facing,
invoked by the model, listed in the Tools catalog) and **hook logic**
(deterministic lifecycle code, never LLM-invoked). Consequences:

- A hook-purpose tool pollutes the Tools catalog and can be (mis)enabled for the LLM
  (validated first-hand: the `smoke:haltGate` smoke-test tool appeared among the 39
  registered tools).
- Tool authoring constraints (OpenAI strict-mode JSON Schema: no `.optional`/
  `.transform`/`.url`…) apply to code that has no LLM schema.
- Data reaches the hook via clumsy `{{path}}` arg templating.
- The halt reply is a magic key (`HOOK_HALT_KEY`) buried in a tool result.

**Goal:** a dedicated, SDK-authored **hook function** type that replaces tool-as-hook
entirely, with a purpose-fit context and a typed control return.

## 2. Decisions (locked in brainstorming)

1. **Full replacement.** Remove the `tool` action type. Hooks are only functions.
2. **Remove tool-side halt.** Delete `HOOK_HALT_KEY` + `extractHalt` + the tool-action
   halt read. The halt *concept* survives as a **typed hook return**.
3. **Expand the SDK** with `defineHook(...)`, authorable in plugin repos.
4. **Hook output is NOT injected into LLM history by default.** Optional via a typed
   return (`injectContext`). The tool-results-in-history flag reverts to being purely
   about cross-turn tool replay.
5. **Hooks may call the LLM** via the ai-gateway, bound to the instance's configured
   model (`ctx.ai`).
6. **No editable config schema in the GUI.** Config = event + which hook function.
   Instance-specific params come from secrets / context store / prompt.
7. **No `ctx.callTool`.** Hooks do not invoke tools; they share helpers or reimplement.
8. **Hooks write to the context store** (`ctx.state`), commit-on-success.
9. **Streaming + response mutation = declare-and-buffer** (see §6, scenario C).
10. **GUI renders hooks distinctly** in Conversazioni + Playground (not as tool results),
    and badges hook-authored assistant messages with their provenance.

## 3. The three scenarios this must serve

- **A — deterministic code at a point in the flow.** Side-effects only (write state,
  call an external API, classify with `ctx.ai`, log). Returns `void`. Any event.
- **B — intercept the user message → conditional prefab assistant reply.** A
  `message_received` hook returns `{ halt: { message } }` *only when* a condition fires
  (else `void` → the supervisor runs). Pre-LLM short-circuit.
- **C — intercept the response → conditionally replace it.** A `response_generated`
  hook returns `{ replaceResponse: { message } }` to swap the LLM's reply before
  delivery. Post-LLM. (The streaming tension is the crux — §6.)

## 4. The `defineHook` contract (SDK)

```ts
import { defineHook } from "@polyant-ai/plugin-sdk";

export default defineHook({
  name: "faq-gate",
  description: "Short-circuit common FAQs before the LLM runs.",
  requiredSecrets: ["faq_api_key"],     // scoped, same spec shape as tools
  mutatesResponse: false,                // true ⇒ turn runs non-streamed (see §6)
  handler: async (ctx): Promise<HookResult> => {
    // ...read ctx, optionally call ctx.ai / write ctx.state...
    return; // or { halt }, { replaceResponse }, { injectContext }
  },
});
```

`HookResult` (all fields optional; `void` = no effect):

```ts
type HookResult =
  | void
  | {
      /** Pre-LLM only (conversation_start, message_received): skip the LLM, reply with this. */
      halt?: { message: string };
      /** response_generated only: replace the LLM reply with this. Requires mutatesResponse. */
      replaceResponse?: { message: string };
      /** Pre-LLM only: extra context appended to this turn's LLM input (one-shot). */
      injectContext?: string;
    };
```

**Field applicability by event** (ignored + warned elsewhere):

| Event | halt | replaceResponse | injectContext | state writes |
|---|---|---|---|---|
| conversation_start (pre-LLM) | ✅ | — | ✅ | ✅ |
| message_received (pre-LLM) | ✅ | — | ✅ | ✅ |
| response_generated (post-LLM) | — | ✅ | — | ✅ |
| response_sent (end) | — | — | — | ✅ |

`halt` is the surviving "halt concept": returning it pre-LLM reuses the entire #158
short-circuit plumbing. `HookHaltSignal` (the `{ message }` shape) stays; the magic
key does not.

## 5. `HookContext` — access surface

Distinct from `ToolContext`. Read-mostly:

```ts
interface HookContext {
  event: HookEvent;
  payload: HookEventPayload;            // instance, conversation, channel, user, message, response?
  history: ModelMessage[];              // conversation message history (already loaded by the pipeline)
  state: ConversationStateApi;          // context store, READ + WRITE (commit-on-success)
  secrets: Record<string, string>;      // scoped to requiredSecrets (least-privilege, like tools)
  instance: { flags: Readonly<InstanceFlags>; provider: string; model: string };
  ai: { chat(input: { messages: ModelMessage[]; system?: string; tier?: "fast" | "standard" | "heavy" }): Promise<string> };
  logger: Logger;
  abortSignal?: AbortSignal;
}
```

- **`ai.chat`** wraps the ai-gateway, pre-bound to the instance's provider/apiKeys/model
  (default = the agent's configured model; `tier` optional). The hook never handles keys.
- **`state`** is the same buffered store tools use: writes ride the commit-on-success
  flush in `runPipelinePost` (aborted turn ⇒ no write); pre-LLM writes are visible to the
  supervisor the same turn; guards (JSON-serializable, 64 KB, audit key+type only) apply.
- **Withheld:** raw DB, filesystem, other instances' data. No `ctx.callTool`.

## 6. Scenario C: streaming vs response mutation — declare-and-buffer

Replacing the final response conflicts physically with token streaming: by the time
`response_generated` runs in `runPipelinePost`, the streaming path has already sent the
tokens to the client. Resolution:

- A hook that may replace the response declares **`mutatesResponse: true`** in `defineHook`.
- When an **enabled `response_generated` hook with `mutatesResponse: true`** exists for the
  instance, the engine serves that turn **non-streamed**: `handleMessageStream` buffers the
  supervisor output (consumes `superviseStream` internally), runs the post-LLM hooks, applies
  any `replaceResponse`, then emits the final text as a single chunk.
- Turns without such a hook stream normally (zero overhead).

Application points for the reply:
- **Pre-LLM `halt`** — `handleMessage` / `handleMessageStream` short-circuit (existing #158
  plumbing) + Room/Webhook engines.
- **Post-LLM `replaceResponse`** — `runPipelinePost` swaps `finalText` before persistence and
  before the adapter sends. Must also be wired into the Room + Webhook engines (they run
  `supervise()` directly and today only fire `message_received`).

Trade-off (documented): an instance with a response-mutating hook loses token streaming on
those turns. Inherent to "mutate the final response".

## 7. GUI

- **Hooks tab (config):** event + hook-function picker (from the new catalog: name +
  description). No args-template editor, no config form. Keep enabled/position/timeout.
- **New catalog endpoint:** `GET /api/hook-functions` (read-only), listing discovered
  functions (name, description, requiredSecrets, mutatesResponse). Mirrors `GET /api/tools`.
- **Conversazioni + Playground rendering:** hook executions render as a distinct **hook chip**
  (not a tool-result pill). An assistant message supplied (`halt`) or replaced
  (`replaceResponse`) by a hook shows a **provenance badge** ("Risposta dall'hook «name»")
  instead of looking like a plain LLM reply. Scenario-A side-effect hooks show an
  informational chip; the assistant message stays LLM-authored.
- **Provenance persistence:** the assistant `conversation_messages` row records a lightweight
  marker (e.g. nullable `source: "hook"` + hook name) so both surfaces can badge it.

## 8. Removal plan (tool-as-hook)

Delete:
- `hooks/actions/tool-action.ts` (+ its test) — the tool executor.
- `hooks/hook-template.ts` + `renderArgsTemplate` (+ test) — `{{path}}` arg templating (only
  existed to feed tool args).
- `HOOK_HALT_KEY` + `extractHalt` from `hook-types.ts` (+ the `hook-halt` test cases that
  target the tool path).
- `hooks/hook-history.ts` `hookExecutionsToModelMessages` / `hookExecutionsToSteps` and their
  use in `runPipelinePre`/`runPipelinePost` — the hook→LLM-history coupling. The
  `toolResultsInHistoryEnabled` flag stays but reverts to cross-turn **tool** replay only.

Change:
- `HookActionConfig` `{ toolName, args }` → `{ functionName }`.
- Keep the executor registry in `hook-runner.ts` (cheap future-proofing) but with `"function"`
  as the only registered type; add `functionActionExecutor` that builds `HookContext`, runs the
  handler, and maps the return to `capture({ halt })` / a new `capture({ replaceResponse })` /
  `capture({ injectContext })`.
- `HookRunContext` grows into (or is replaced by) `HookContext` (history + ai + richer state).

Add:
- SDK `defineHook` + `HookResult` types (in `@polyant-ai/plugin-sdk`; engine re-exports).
- Hook loader + `getHookRegistry()` (parallel to the tool loader): plugin `hooksDir`
  (default `hooks/`), `*.hook.ts` default-exporting `defineHook`, named `<namespace>:<name>`.
- **Room state buffer:** the room cycle must load a `ConversationStateBuffer` (webhook already
  does) so hooks in Room can write context uniformly (#158 passed `state: undefined`).
- DB migration: `action_type` no longer accepts `tool`; **delete existing `action_type='tool'`
  rows** (the `action_config` shape is incompatible; the operator reconfigures as functions).

## 9. Out of scope

- A config schema / GUI form for hooks (params via secrets/state/prompt).
- `ctx.callTool`.
- `injectContext` / `replaceResponse` at events where they don't apply (ignored + warned).
- Response mutation *with* preserved token streaming (physically excluded — declare-and-buffer).

## 10. Verification

- SDK: `defineHook` serialization + a fixture hook loads via the hook loader into
  `getHookRegistry()`.
- Runner: `function` executor maps `halt` / `replaceResponse` / `injectContext` returns to the
  captured control fields; `void` = no effect; first `halt` wins (existing chain-break).
- Pre-LLM `halt`: `handleMessage` + `handleMessageStream` short-circuit (reuse #158 tests,
  re-pointed at the function executor); Room + Webhook.
- Post-LLM `replaceResponse`: `handleMessage` swaps the reply; `handleMessageStream` with a
  `mutatesResponse` hook runs buffered and emits the replaced text; Room + Webhook swap.
- `ctx.state` writes from a hook persist commit-on-success and are visible next turn; Room
  buffer wired.
- `ctx.ai.chat` calls the gateway with the instance model.
- Migration removes tool hooks; the Tools catalog no longer shows hook-only entries.
- Full `typecheck` + `lint` + `test:unit` green.

## 11. Sequencing

Separate PR, branched from develop **after #158 merged** (done). #158's short-circuit
plumbing is reused; this PR removes the tool-as-hook layer and adds the function layer on top.
