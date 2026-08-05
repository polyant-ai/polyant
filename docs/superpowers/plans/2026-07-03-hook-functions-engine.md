# Hook Functions (SDK + Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tool-as-hook with a dedicated SDK-authored **hook function** type: `defineHook` in `@polyant-ai/plugin-sdk`, a purpose-fit `HookContext` (message history + context store R/W + LLM via ai-gateway), and a typed control return (`halt` / `replaceResponse` / `injectContext`).

**Architecture:** A parallel hook loader/registry (mirroring the tool loader) feeds a `functionActionExecutor` that builds a `HookContext`, runs the hook's `handler`, and maps its return onto the existing capture→`firstHalt`→shortCircuit plumbing from #158. Post-LLM response replacement swaps `finalText` in `runPipelinePost`; streaming turns with a `mutatesResponse` hook fall back to a buffered single-chunk emit (declare-and-buffer). The tool action type, arg-templating, magic halt key, and hook→LLM-history coupling are removed.

**Tech Stack:** TypeScript (ESM), NestJS, Drizzle, Vitest, Vercel AI SDK v6, `@polyant-ai/plugin-sdk` (git dep).

**Spec:** `docs/superpowers/specs/2026-07-03-hook-functions-design.md`

**Scope:** SDK + engine backend only. The **web** side (catalog consumption, config form + streaming warning, hook-chip rendering, provenance badge) is a **separate plan** written afterward, depending on the `GET /api/hook-functions` endpoint (Task 12) and the `metadata.source` provenance (Task 8).

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| **polyant-sdk repo** `src/hooks.ts` (+ index export) | `defineHook`, `HookResult`, `HookContext`, `HookFunctionDefinition` types | Create (cross-repo) |
| `hooks/hook-types.ts` | Engine-side re-exports + `HookResult`; drop `HOOK_HALT_KEY`/`extractHalt`; `HookActionConfig={functionName}`; `HOOK_ACTION_TYPES=["function"]`; add `replaceResponse`/`injectContext` to capture+summary | Modify |
| `hooks/hook-registry.ts` | `getHookRegistry()` + Map (writer = loader) | Create |
| `hooks/hook-loader.ts` | `loadAllHooks()` scanning `hooksDir`/`*.hook.ts` (mirror tool loader) | Create |
| `hooks/actions/function-action.ts` | `functionActionExecutor`: build `HookContext`, run handler, map return | Create |
| `hooks/hook-context.ts` | `buildHookContext(...)` + `ctx.ai` wrapper over ai-gateway | Create |
| `hooks/hook-runner.ts` | Register function executor (only); surface `replaceResponse`/`injectContext`; `firstReplaceResponse`/`collectInjectContext` helpers | Modify |
| `plugin-system/plugin-manifest.ts` | add `hooksDir` (default `"hooks"`) | Modify |
| `pipeline.ts` | `runPipelinePre` applies `injectContext` (drop `hookExecutionsToModelMessages`); `runPipelinePost` applies `replaceResponse` + provenance; `hasResponseMutatingHook()` | Modify |
| `index.ts` | `handleMessageStream` declare-and-buffer branch | Modify |
| `room/room-engine.ts` | add state buffer + wire `response_generated` + replace + provenance | Modify |
| `webhooks/webhook-engine.ts` | wire `response_generated` + replace + provenance | Modify |
| `server/hooks/hook-functions.controller.ts` | `GET /api/hook-functions` catalog | Create |
| `database/migrations/00XX_hook_functions.sql` | drop tool hooks; `action_type` enum → function | Create |
| **Delete:** `hooks/actions/tool-action.ts`(+test), `hooks/hook-template.ts`(+test), `hooks/hook-history.ts`(+test) | tool executor, arg templating, hook→history coupling | Delete |

---

## ⚠️ Pre-requisite

- [ ] Branch `feat/hook-functions` is off develop (contains #158). Baseline green: `npm run typecheck -w @polyant/engine && npm run test:unit -w @polyant/engine`.
- [ ] The polyant-sdk repo (`github.com/polyant-ai/polyant-sdk`) is available to edit + release (Task 1 is cross-repo). If it cannot be released in this session, do Task 1's types **engine-locally** in `hook-types.ts` as a temporary shim and open a follow-up to move them to the SDK — but the preferred path is the SDK.

---

## Task 1: SDK — `defineHook` contract (cross-repo: polyant-sdk)

> **STATUS: DONE in [polyant-sdk#3](https://github.com/polyant-ai/polyant-sdk/pull/3)** (targets v1.2.0; pending review + merge + tag). The canonical contract lives there; the code below reflects the shipped shape (`HookSpec` → normalized `HookFunctionDefinition`, `defineHook` validates `requiredSecrets` at load). Once v1.2.0 is tagged, bump the engine pin (Step 3) and start at Task 2.

**Files:**
- Create in the **polyant-sdk repo**: `src/hooks.ts`
- Modify: the SDK's `src/index.ts` (barrel export)

- [ ] **Step 1: Add the contract**

`src/hooks.ts` — **REUSE the v1.1.0 structural primitives** (`ConversationStateApi`, `ConversationHistoryApi`, `ConversationMessage`, `ToolApiKeys`, `AuditLogger`, `RequiredSecretsInput`) already in `context-types.ts`; do NOT reinvent them (no `HookStateApi`/`HookSecretSpec`). No `ai` package dep — the LLM accessor takes structural `ConversationMessage[]`.

```ts
// SPDX-License-Identifier: Apache-2.0
import type {
  ConversationStateApi,
  ConversationHistoryApi,
  ConversationMessage,
  ToolApiKeys,
  AuditLogger,
} from "./context-types.js";
import type { RequiredSecretsInput } from "./contract.js"; // RequiredSecretsInput is exported from contract.js, not context-types.js

/** Lifecycle events a hook can subscribe to (mirror of the engine enum). */
export type HookEvent =
  | "conversation_start"
  | "message_received"
  | "response_generated"
  | "response_sent";

/** Server-built event payload (the only trusted data source). */
export interface HookEventPayload {
  instance: { slug: string };
  conversation: { id: string };
  channel: { type: string; id: string };
  user: { name: string };
  message: { text: string };
  response?: { text: string };
}

/** LLM access bound to the instance's configured model, via the engine ai-gateway. */
export interface HookAi {
  chat(input: {
    messages: ConversationMessage[];
    system?: string;
    tier?: "fast" | "standard" | "heavy";
  }): Promise<string>;
}

/** Everything a hook handler receives. Read-mostly; writes only via `state`. Modelled on ToolContext. */
export interface HookContext {
  event: HookEvent;
  payload: HookEventPayload;
  /** Read-only recent conversation history — reuses the tool history accessor. */
  conversation: ConversationHistoryApi;
  /** Shared per-conversation state — READ + WRITE (commit-on-success). */
  state: ConversationStateApi;
  secrets: Record<string, string>;
  instance: { slug: string; provider?: string; model?: string; flags: Record<string, boolean> };
  apiKeys?: ToolApiKeys;
  ai: HookAi;
  audit: AuditLogger;
  abortSignal?: AbortSignal;
}

/** What a hook may return to influence the turn. `void` = no effect. */
export type HookResult =
  | void
  | {
      /** Pre-LLM only (conversation_start, message_received): skip the LLM, reply with this. */
      halt?: { message: string };
      /** response_generated only: replace the LLM reply with this. Requires mutatesResponse. */
      replaceResponse?: { message: string };
      /** Pre-LLM only: extra one-shot context appended to this turn's LLM input. */
      injectContext?: string;
    };

export interface HookFunctionDefinition {
  name: string;
  description: string;
  /** Same spec shape as tools (reuses the SDK RequiredSecretsInput). */
  requiredSecrets?: RequiredSecretsInput;
  /** True ⇒ turns with this hook on `response_generated` run non-streamed (declare-and-buffer). */
  mutatesResponse?: boolean;
  handler: (ctx: HookContext) => Promise<HookResult> | HookResult;
}

/** Identity passthrough (mirrors defineTool): the engine consumes this object. */
export function defineHook(def: HookFunctionDefinition): HookFunctionDefinition {
  return def;
}
```

Conflict check (done, 2026-07-06): v1.1.0 exports no `Hook*`/`defineHook` names — clean. It already provides the reused primitives above.

- [ ] **Step 2: Export from the barrel**

Add to the SDK's `src/index.ts`:

```ts
export { defineHook } from "./hooks.js";
export type {
  HookFunctionDefinition, HookResult, HookContext, HookEvent,
  HookEventPayload, HookStateApi, HookSecretSpec,
} from "./hooks.js";
```

- [ ] **Step 3: Release + bump the engine pin**

NOTE: develop already pins `@polyant-ai/plugin-sdk#v1.1.0` (a routine bump, #161 — it does **not** contain `defineHook`; the installed package shows 1.0.0). So tag the **next** SDK release (e.g. `v1.2.0`) with `defineHook` and update `packages/engine/package.json`:

```
"@polyant-ai/plugin-sdk": "git+https://github.com/polyant-ai/polyant-sdk.git#v1.2.0",
```

Then `npm install` at the monorepo root. Verify: `node -e "import('@polyant-ai/plugin-sdk').then(m=>console.log(typeof m.defineHook))"` prints `function`.

- [ ] **Step 4: Commit (SDK repo + engine pin bump)** — two commits in two repos.

---

## Task 2: Engine hook-types — function contract + drop tool halt

**Files:**
- Modify: `packages/engine/src/hooks/hook-types.ts`
- Test: `packages/engine/src/hooks/hook-halt.test.ts` (remove the tool-halt cases)

- [ ] **Step 1: Rewrite the contract section**

In `hook-types.ts`, **remove** `HOOK_HALT_KEY` and `extractHalt`. Keep `HookHaltSignal`. Re-export the SDK types and add engine-only capture/summary fields:

```ts
import type { HookResult, HookContext, HookFunctionDefinition } from "@polyant-ai/plugin-sdk";
export type { HookResult, HookContext, HookFunctionDefinition };

export interface HookHaltSignal { message: string; }
export interface HookReplaceSignal { message: string; }

export const HOOK_ACTION_TYPES = ["function"] as const;
export type HookActionType = (typeof HOOK_ACTION_TYPES)[number];

/** For `function` actions: which registered hook function to run. */
export interface HookActionConfig {
  functionName: string;
}
```

Extend `HookExecutionCapture` and `HookExecutionSummary` (keep existing fields; `args`/`result` stay for telemetry of the function's own logging if any, but add):

```ts
// on both HookExecutionCapture and HookExecutionSummary:
  halt?: HookHaltSignal;
  replaceResponse?: HookReplaceSignal;
  injectContext?: string;
```

Rename the `toolName` field on `HookExecutionSummary`/`InstanceHookRow`/telemetry to `functionName` OR keep `toolName` as the generic "action target name" — **decision: rename to `actionName`** across `HookExecutionSummary`, `recordHookExecution`, and `hook_executions` (a follow-on migration column rename; or keep `tool_name` column and map). To minimise churn: keep the DB column `tool_name` but populate it with the function name; expose it as `actionName` in the summary type. Document this in the code comment.

- [ ] **Step 2: Update the halt test**

In `hook-halt.test.ts`, delete the `extractHalt` describe block entirely (the function no longer exists). Keep the `firstHalt` describe block (it still applies). 

- [ ] **Step 3: Run + commit**

`npm run test:unit -w @polyant/engine -- hook-halt` → PASS (firstHalt cases only). Commit.

---

## Task 3: Hook registry + loader (mirror the tool loader)

**Files:**
- Create: `packages/engine/src/hooks/hook-registry.ts`
- Create: `packages/engine/src/hooks/hook-loader.ts`
- Modify: `packages/engine/src/plugin-system/plugin-manifest.ts`
- Test: `packages/engine/src/hooks/hook-loader.test.ts`

- [ ] **Step 1: Manifest `hooksDir`**

In `plugin-manifest.ts` `pluginManifestSchema` (lines 13–25), add after `toolsDir`:

```ts
  /** Where *.hook.ts files live. Defaults to "hooks". */
  hooksDir: z.string().min(1).default("hooks"),
```

- [ ] **Step 2: Registry**

`hook-registry.ts` (mirror `registry.ts:94,121-123`):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HookFunctionDefinition } from "@polyant-ai/plugin-sdk";

const registry = new Map<string, HookFunctionDefinition>();

export function getHookRegistry(): ReadonlyMap<string, HookFunctionDefinition> {
  return registry;
}

/** Loader-only writer. */
export function _setHook(name: string, def: HookFunctionDefinition): void {
  registry.set(name, def);
}

/** Test-only. */
export function _registerHookForTests(def: HookFunctionDefinition, namespace: string | null = null): void {
  registry.set(namespace ? `${namespace}:${def.name}` : def.name, def);
}
```

- [ ] **Step 3: Loader**

`hook-loader.ts` — mirror `registry.ts` `loadAllTools()` (337–365) + `importRoot()` (292–328), but scanning `*.hook.ts` in each root's `hooksDir`, default-exporting a `HookFunctionDefinition` (detected by the presence of a `handler` function), named `<namespace>:<name>`. Reuse `resolvePluginRoots({ envDirs: config.plugins.dirs, conventionDir })` (plugin-roots.ts:20–36) and `readPluginManifest`. Core hooks dir = `src/hooks/functions/` (namespace null). Skip files without a `handler`; fail boot loudly on duplicate final names (mirror the tool loader's collision handling). Wire `loadAllHooks()` into the boot sequence in `index.ts` right after `loadAllTools()`.

- [ ] **Step 4: Test** — a fixture hook dir + `loadAllHooks()` populates `getHookRegistry()` with `<ns>:<name>`; a file without a handler is skipped. Mirror `plugin-loading.integration.test.ts`.

- [ ] **Step 5: Run + commit.**

---

## Task 4: `HookContext` builder + `ctx.ai`

**Files:**
- Create: `packages/engine/src/hooks/hook-context.ts`
- Test: `packages/engine/src/hooks/hook-context.test.ts`

- [ ] **Step 1: Builder** — reuse the SDK structural types + the engine's EXISTING conversation-history accessor (the one already built for `ToolContext.conversation` in v1.1.0 — find its builder in `agents/tools/registry.ts`/`buildTool` and reuse it, so hooks and tools share one accessor). `ctx.ai.chat` maps the structural `ConversationMessage[]` → `ModelMessage[]` and calls the gateway.

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ModelMessage } from "ai";
import type { HookContext } from "@polyant-ai/plugin-sdk";
import type { ConversationHistoryApi, ConversationStateApi, AuditLogger } from "@polyant-ai/plugin-sdk";
import { chat } from "../ai-gateway/index.js";
import type { HookRunContext, HookEventPayload, HookEvent } from "./hook-types.js";

export function buildHookContext(
  event: HookEvent,
  payload: HookEventPayload,
  ctx: HookRunContext,
  conversation: ConversationHistoryApi,   // reuse the same accessor tools get
  audit: AuditLogger,
): HookContext {
  return {
    event,
    payload,
    conversation,
    state: ctx.state ?? emptyState(),
    secrets: ctx.secrets,
    instance: { slug: ctx.instanceId, provider: ctx.provider, model: ctx.model, flags: ctx.flags ?? {} },
    apiKeys: ctx.apiKeys,
    ai: {
      async chat(input) {
        const messages: ModelMessage[] = input.messages.map((m) => ({ role: m.role, content: m.content }) as ModelMessage);
        const res = await chat(
          { tier: input.tier ?? "standard", provider: ctx.provider, model: ctx.model, apiKeys: ctx.apiKeys, system: input.system, messages, abortSignal: ctx.abortSignal },
          { conversationId: ctx.conversationId, instanceId: ctx.instanceId, callType: "service" },
        );
        return res.text;
      },
    },
    audit,
    abortSignal: ctx.abortSignal,
  };
}

function emptyState(): ConversationStateApi {
  return { get: () => undefined, set: () => {}, getAll: () => ({}), delete: () => {}, channel: undefined };
}
```

Extend `HookRunContext` (in `hook-types.ts`) with `model?: string`, `flags?: Record<string, boolean>`, and `apiKeys` (already present). Populate `model`/`flags` in `buildHookRunContext` (pipeline.ts) + the room/webhook contexts from `instanceConfig`. The `conversation` accessor + `audit` are passed by the executor (Task 5), obtained the same way `buildTool` obtains them for tools.

- [ ] **Step 2: Test** — `ctx.ai.chat` calls the mocked gateway `chat` with `tier` default `"standard"`, the instance provider/model, and returns `.text`; `state` falls back to a no-op when absent.

- [ ] **Step 3: Run + commit.**

---

## Task 5: `functionActionExecutor`

**Files:**
- Create: `packages/engine/src/hooks/actions/function-action.ts`
- Test: `packages/engine/src/hooks/actions/function-action.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("runs the hook and captures halt/replaceResponse/injectContext", async () => {
  registryMock.set("smoke:gate", { name: "gate", description: "", handler: async () => ({ halt: { message: "no" } }) });
  const captured: HookExecutionCapture = {};
  await functionActionExecutor.execute(
    hookFor("smoke:gate"), payload, ctx, (d) => Object.assign(captured, d),
  );
  expect(captured.halt).toEqual({ message: "no" });
});
```
(Mock `../hook-registry.js` `getHookRegistry` → a Map, like tool-action.test mocks the tool registry. `hookFor(name)` builds an `InstanceHookRow` with `actionType:"function"`, `actionConfig:{functionName:name}`.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import { getHookRegistry } from "../hook-registry.js";
import { buildHookContext } from "../hook-context.js";
import type { HookActionExecutor } from "../hook-types.js";

const MAX_HOOK_RESULT_CHARS = 4000;

export const functionActionExecutor: HookActionExecutor = {
  async execute(hook, payload, ctx, capture) {
    const { functionName } = hook.actionConfig;
    const def = getHookRegistry().get(functionName);
    if (!def) throw new Error(`hook function "${functionName}" is not registered`);

    const hookCtx = buildHookContext(hook.event, payload, ctx, ctx.history ?? []);
    const result = await def.handler(hookCtx);
    if (!result) return;

    if (result.halt?.message?.trim()) capture({ halt: { message: result.halt.message } });
    if (result.replaceResponse?.message?.trim()) {
      // Runtime enforcement of the `replaceResponse ⇒ mutatesResponse` contract
      // (it can't be checked statically in defineHook — the value is a handler
      // return). Never a silent no-op: warn when the flag is missing, since on a
      // streamed turn the reply was already sent (declare-and-buffer didn't run).
      if (!def.mutatesResponse) {
        console.warn(`[hooks] "${functionName}" returned replaceResponse without declaring mutatesResponse:true — honored only on non-streamed turns.`);
      }
      capture({ replaceResponse: { message: result.replaceResponse.message } });
    }
    if (typeof result.injectContext === "string" && result.injectContext.trim()) {
      capture({ injectContext: result.injectContext.slice(0, MAX_HOOK_RESULT_CHARS) });
    }
  },
};
```

Add `history?: ModelMessage[]` to `HookRunContext` so the executor can pass it.

- [ ] **Step 4: Run → PASS. Commit.**

---

## Task 6: Register the function executor; remove the tool executor + templating + hook-history

**Files:**
- Modify: `packages/engine/src/hooks/hook-runner.ts`
- Delete: `hooks/actions/tool-action.ts` (+test), `hooks/hook-template.ts` (+test), `hooks/hook-history.ts` (+test)
- Modify: `packages/engine/src/pipeline.ts` (imports)

- [ ] **Step 1: Swap the executor + add helpers**

In `hook-runner.ts`: replace the `tool` executor registration and import:

```ts
import { functionActionExecutor } from "./actions/function-action.js";
const executors = new Map<HookActionType, HookActionExecutor>([
  ["function", functionActionExecutor],
]);

export function firstReplaceResponse(summaries: HookExecutionSummary[]): HookReplaceSignal | undefined {
  return summaries.find((s) => s.replaceResponse)?.replaceResponse;
}
export function collectInjectContext(summaries: HookExecutionSummary[]): string[] {
  return summaries.map((s) => s.injectContext).filter((c): c is string => !!c);
}
```

Keep `firstHalt`. Add `replaceResponse`/`injectContext` to the pushed summary object (alongside `halt`). Keep the `if (captured.halt) break;` chain-break (pre-LLM). (Do NOT break on `replaceResponse` — post-LLM hooks should all run.)

- [ ] **Step 2: Delete the three files + their tests** and remove their imports from `pipeline.ts` (the `hookExecutionsToModelMessages`/`hookExecutionsToSteps` import on line 17, and their uses in `runPipelinePre`/`runPipelinePost`). Replace the `toolResultsInHistoryEnabled`-gated hook injection in `runPipelinePre` with the injectContext application (Task 7).

- [ ] **Step 3: `npm run typecheck -w @polyant/engine`** → fix references. Commit.

---

## Task 7: Pre-LLM — apply `injectContext` (+ halt reuse)

**Files:**
- Modify: `packages/engine/src/pipeline.ts` (`runPipelinePre`)

- [ ] **Step 1:** In `runPipelinePre`, after the pre-LLM hooks run, replace the removed hook-history block with:

```ts
  // Pre-LLM hooks may contribute one-shot context to this turn's LLM input.
  const injected = collectInjectContext(hookExecutions);
  if (injected.length > 0) {
    const sys: ModelMessage[] = injected.map((text) => ({ role: "system", content: text }));
    ctx.history = [...(ctx.history ?? []), ...sys];
  }
  const halt = firstHalt(hookExecutions);
  return { ctx, contextPrepMs, messageText: msg.text, hookExecutions, shortCircuit: halt ? { text: halt.message } : undefined };
```

Also set `ctx.history` onto the `HookRunContext` in `buildHookRunContext` (so hooks receive history): add `history: ctx.history ?? []` there, plus `model: ctx.instanceConfig.model` and `flags: { memory: ctx.instanceConfig.memoryEnabled, thinking: ctx.instanceConfig.thinkingEnabled, debug: ctx.instanceConfig.debugEnabled, knowledge: ctx.instanceConfig.knowledgeEnabled, stateInPrompt: ctx.instanceConfig.stateInPromptEnabled, toolResultsInHistory: ctx.instanceConfig.toolResultsInHistoryEnabled }`.

- [ ] **Step 2: typecheck + commit.**

---

## Task 8: Post-LLM — apply `replaceResponse` + provenance (sync path)

**Files:**
- Modify: `packages/engine/src/pipeline.ts` (`runPipelinePost`, `afterResponse`)
- Test: extend a pipeline test or add `pipeline-response-replace.test.ts`

- [ ] **Step 1:** In `runPipelinePost`, after `runHooks("response_generated", …)`:

```ts
  let finalText = opts.resultText;
  let provenance: { source: "hook"; hookName: string } | undefined;
  const replace = firstReplaceResponse(hookExecutions);
  if (replace) {
    finalText = replace.message;
    const src = hookExecutions.find((s) => s.replaceResponse);
    provenance = { source: "hook", hookName: src?.actionName ?? "hook" };
  }
```

Thread `finalText` into `afterResponse({ …, assistantResponse: finalText, provenance })` and return `{ finalText, hookExecutions }`. If the turn was a pre-LLM halt, set `provenance = { source: "hook", hookName }` there too (thread the halting hook's name from `pre.hookExecutions`).

- [ ] **Step 2:** In `afterResponse`, pass provenance into the assistant `appendMessages(...)` call as `metadata`:

```ts
    { role: "assistant", content: assistantResponse, steps, ...(reasoning ? { reasoning } : {}),
      ...(debugPayload ? { debugPayload } : {}),
      ...(provenance ? { metadata: provenance } : {}) },
```

(No migration — `conversation_messages.metadata` jsonb already exists, schema.ts:85–121.) Confirm `getMessages` selects `metadata`; if not, add it to the select so the web can read provenance.

- [ ] **Step 3: Test** — a `response_generated` hook returning `replaceResponse` makes `runPipelinePost` return the replaced text and persist `metadata:{source:"hook",…}`. Run + commit.

---

## Task 9: Streaming — declare-and-buffer

**Files:**
- Modify: `packages/engine/src/index.ts` (`handleMessageStream`)
- Modify: `packages/engine/src/pipeline.ts` (`hasResponseMutatingHook` helper)

- [ ] **Step 1: Helper** in `pipeline.ts`:

```ts
import { getHookRegistry } from "./hooks/hook-registry.js";
import { getEnabledHooks } from "./hooks/hooks.store.js";
import { resolveInstanceId } from "./instances/resolve-instance-id.js";

/** True if the instance has an enabled response_generated hook whose function declares mutatesResponse. */
export async function hasResponseMutatingHook(instanceSlug: InstanceSlug): Promise<boolean> {
  const uuid = await resolveInstanceId(instanceSlug).catch(() => null);
  if (!uuid) return false;
  const hooks = await getEnabledHooks(uuid, "response_generated").catch(() => []);
  const reg = getHookRegistry();
  return hooks.some((h) => reg.get(h.actionConfig.functionName)?.mutatesResponse === true);
}
```

- [ ] **Step 2:** In `handleMessageStream`, after `const pre = await runPipelinePre(...)` and the existing `pre.shortCircuit` block, add — BEFORE calling `superviseStream`:

```ts
    // A response-mutating hook cannot coexist with token streaming: run this turn
    // buffered (non-streamed) and emit the final (possibly replaced) text as one chunk.
    if (await hasResponseMutatingHook(ctx.instanceId)) {
      const out = await handleMessage(msg, abortSignal); // sync path: supervise + response_generated replace
      const text = out.text;
      const messageId = randomUUID();
      return {
        textStream: (async function* () { yield text; })(),
        fullStream: (async function* () { yield { type: "text-delta", text }; })(),
        completed: Promise.resolve({ text, hookExecutions: [] }),
        meta: { conversationId: ctx.conversationId, messageId },
        hookExecutions: pre.hookExecutions,
      };
    }
```

**Caveat to encode:** `handleMessage` re-runs `runPipelinePre` (a second hook pass for pre-LLM events). To avoid double-firing pre-LLM hooks, guard: only take this branch when `!pre.shortCircuit` (already returned above) and accept the second pre-pass, OR (preferred) extract the supervise+post portion of `handleMessage` into a helper `runBufferedTurn(msg, pre, abortSignal)` shared by both. **Use the helper** to avoid the double pre-hook pass.

- [ ] **Step 3: typecheck + manual/integration verify** (streaming turn with a mutatesResponse hook → single chunk, replaced text). Commit.

---

## Task 10: Room engine — state buffer + response_generated + provenance

**Files:**
- Modify: `packages/engine/src/room/room-engine.ts`
- Test: `packages/engine/src/room/room-engine.test.ts`

- [ ] **Step 1:** Load a state buffer (mirror webhook-engine.ts:136–142) before the hook wiring:

```ts
import { ConversationStateBuffer } from "../conversations/state.buffer.js";
const stateBuffer = await ConversationStateBuffer.load(conversationId, instanceSlug).catch(() => new ConversationStateBuffer(conversationId, instanceSlug));
```

Pass `state: stateBuffer.api()`, `model: instanceConfig.model`, `flags: {…}`, `history` into the `message_received` `HookRunContext` (replacing `state: undefined`). Flush after the cycle (commit-on-success): `await stateBuffer.flush().catch(...)`.

- [ ] **Step 2:** After `supervise()` (line ~176) and computing `result`, run `response_generated` + apply replace before `finalText` (line 202):

```ts
  const postHooks = await runHooks("response_generated", buildHookPayloadRoom(result!.text), hookCtxWithHistory);
  const replace = firstReplaceResponse(postHooks);
  const finalText = halt ? halt.message : (replace ? replace.message : result!.text);
  const provenance = (halt || replace) ? { source: "hook" as const, hookName: /* name */ } : undefined;
```

Add `provenance` to the assistant `appendMessages` (line 214–216) as `metadata`. (Room has no streaming, so no buffering concern.)

- [ ] **Step 3: Test** — a `response_generated` room hook replaces `finalText` + persists provenance; supervise still called (replace is post-LLM). Run + commit.

---

## Task 11: Webhook engine — response_generated + provenance

**Files:**
- Modify: `packages/engine/src/webhooks/webhook-engine.ts`
- Test: `packages/engine/src/webhooks/webhook-engine.test.ts`

- [ ] **Step 1:** After `supervise()` (191–210), before `finalText` (231–233), run `response_generated` (state buffer already exists; pass it + history + model + flags) and apply replace exactly as Task 10 Step 2. Add provenance metadata to the assistant `appendMessages` (236–238). Webhook is non-streaming → no buffering.

- [ ] **Step 2: Test** (mirror the existing webhook halt test): a `response_generated` webhook hook replaces the sent text + persists provenance. Run + commit.

---

## Task 12: Catalog endpoint `GET /api/hook-functions`

**Files:**
- Create: `packages/engine/src/server/hooks/hook-functions.controller.ts` (+ register in the hooks module)
- Test: `hook-functions.controller.test.ts`

- [ ] **Step 1:** Mirror `ToolsController` (`server/tools`, `GET /api/tools`). Return, from `getHookRegistry()`, a read-only list:

```ts
@Public() // read-only catalog, same posture as /api/tools
@Get("/api/hook-functions")
list() {
  return [...getHookRegistry().entries()].map(([name, def]) => ({
    name,
    description: def.description,
    requiredSecrets: def.requiredSecrets, // already normalized by defineHook (RequiredSecretSpec[])
    mutatesResponse: def.mutatesResponse === true,
  }));
}
```

(`defineHook` normalizes `requiredSecrets` at load — the registry already holds `RequiredSecretSpec[]`, so no re-normalization here.)

- [ ] **Step 2: Test** — endpoint returns the registered hook functions with `mutatesResponse`. Run + commit.

---

## Task 13: DB migration — remove tool hooks

**Files:**
- Create: `packages/engine/src/database/migrations/00XX_hook_functions.sql` (next number)
- Modify: `instance_hooks` schema (`hooks.schema.ts`) if `action_type` is an enum/check

- [ ] **Step 1:** Write the migration by hand (no drizzle-kit snapshots in this repo — see CLAUDE.md):

```sql
-- Remove tool-as-hook: the action_config shape is incompatible with hook functions.
DELETE FROM instance_hooks WHERE action_type = 'tool';
-- If action_type is a CHECK/enum constrained to ('tool'), relax to ('function'):
-- ALTER TABLE instance_hooks DROP CONSTRAINT IF EXISTS instance_hooks_action_type_check;
-- ALTER TABLE instance_hooks ADD CONSTRAINT instance_hooks_action_type_check CHECK (action_type IN ('function'));
```

Adjust the second block to the actual constraint (inspect `hooks.schema.ts`). Update the Drizzle schema's `actionType` default/enum to `"function"`.

- [ ] **Step 2:** Apply against a scratch DB (`npm run db:migrate`) and confirm it runs. Commit.

---

## Task 14: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` (hooks bullet)

- [ ] **Step 1:** Rewrite the hooks bullet: action type is now `function` (SDK `defineHook`); tools are no longer hooks; `HookContext` (history + state R/W + `ctx.ai`); returns `halt`/`replaceResponse`/`injectContext`; declare-and-buffer for streaming; provenance in `metadata`; catalog `GET /api/hook-functions`. Point to the spec.

- [ ] **Step 2: Full gate:**

```bash
npm run typecheck -w @polyant/engine
npm run lint -w @polyant/engine
npm run test:unit -w @polyant/engine
```
All green (0 lint errors). Then a live smoke test mirroring the #158 approach (worktree + ephemeral pgvector + a plugin `*.hook.ts` that returns `halt`, and one with `mutatesResponse` + `replaceResponse`) via `/v1` sync + stream.

- [ ] **Step 3: Commit.**

---

## Self-Review notes (author)

- **Spec coverage:** SDK contract (§4)→T1–2; loader/registry (§8 add)→T3; HookContext incl. `ctx.ai`+state+history (§5)→T4; executor + return mapping (§4)→T5; removal of tool-action/template/hook-history + halt-key (§8 delete)→T2,T6; injectContext (§4)→T7; replaceResponse + provenance (§3C,§7)→T8,T10,T11; declare-and-buffer (§6)→T9; Room state buffer (§8)→T10; catalog (§7)→T12; migration (§8)→T13; docs→T14. Scenarios A(void)/B(halt)/C(replace) all covered.
- **Web is a separate plan** (config form + streaming warning + hook chip + provenance badge) — depends on T8 (`metadata.source`) + T12 (catalog).
- **Type consistency:** `HookResult`/`HookContext`/`HookFunctionDefinition` from SDK used identically T1→T5; `firstHalt`/`firstReplaceResponse`/`collectInjectContext` consistent; `actionName` (summary) vs `tool_name` (DB column) reconciliation flagged in T2.
- **Open latitude:** the `actionName`/`tool_name` rename (T2) — kept the DB column, renamed the type field, to avoid a column-rename migration; revisit if it reads awkwardly.
