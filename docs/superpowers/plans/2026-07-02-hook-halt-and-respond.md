# Hook Halt-and-Respond Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a pre-LLM hook interrupt the pipeline and emit a system-authored reply that is persisted as the assistant message and delivered to the user, across every flow that reaches the LLM.

**Architecture:** A tool executed by a hook returns a reserved key `{ [HOOK_HALT_KEY]: { message } }`. The hook runner detects it, stops the chain, and each LLM entry point short-circuits: the conversational pipeline (`handleMessage`/`handleMessageStream`) via a `shortCircuit` field on the pre-result; the supervise-direct engines (Room, Webhook) via manual wiring before their `supervise()` call. Synthetic channels (`scheduled`, `agent`) are un-suppressed so they too run hooks.

**Tech Stack:** TypeScript (ESM), NestJS, Vitest, Vercel AI SDK v6, `@polyant-ai/plugin-sdk` (serialized tool contract).

---

## ⚠️ Pre-requisite — execute AFTER the SDK merge

This plan is **deferred until `feat/tool-serialized-plugins` (the plugin SDK) lands in `develop`**. Before starting:

- [ ] Confirm `@polyant-ai/plugin-sdk` is merged into `develop` and `packages/engine/src/agents/tools/registry.ts` exposes `def.execute(input, ctx)` + `fillAndValidate` + `ToolContext`.
- [ ] Rebase `feat/hook-halt-and-respond` onto the updated `develop`: `git rebase develop`.
- [ ] Run the baseline: `npm run typecheck -w @polyant/engine && npm run test:unit -w @polyant/engine` — all green before starting.

**Contract note:** Task 2 targets the **post-merge** `tool-action.ts` (`def.execute`). All tool stubs in tests use the SDK `defineTool` shape. Line anchors for `tool-action.ts` and its test are approximate (the SDK branch churns them) — locate by symbol.

**Scope note:** `HOOK_HALT_KEY`/`HookHaltSignal` are defined in engine (`hooks/hook-types.ts`) so first-party tools work. Promoting them to `@polyant-ai/plugin-sdk` (so *external* plugin tools can import them) is a documented follow-up in that separate repo — NOT required for v1 (the halt use cases are first-party tools). See spec §8.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `hooks/hook-types.ts` | Halt contract: constant, type, `extractHalt`, `halt?` on capture/summary | Modify |
| `hooks/hook-runner.ts` | `firstHalt` helper; break the chain on halt | Modify |
| `hooks/actions/tool-action.ts` | Detect halt in the tool result, report via `capture` | Modify |
| `pipeline.ts` | Surface `shortCircuit` from `runPipelinePre`; un-suppress synthetic channels in `buildHookPayload` | Modify |
| `index.ts` | Short-circuit in `handleMessage` + `handleMessageStream` | Modify |
| `room/room-engine.ts` | Wire `message_received` + halt before `supervise()`; send canned reply outbound | Modify |
| `webhooks/webhook-engine.ts` | Wire `message_received` + halt before `supervise()` | Modify |
| `hooks/hook-halt.test.ts` | Unit tests for `extractHalt` + `firstHalt` | Create |
| `CLAUDE.md` | Document the halt mechanism | Modify |

---

## Task 1: Halt contract (types + `extractHalt` + `firstHalt`)

**Files:**
- Modify: `packages/engine/src/hooks/hook-types.ts`
- Modify: `packages/engine/src/hooks/hook-runner.ts`
- Create: `packages/engine/src/hooks/hook-halt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/hooks/hook-halt.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { HOOK_HALT_KEY, extractHalt } from "./hook-types.js";
import { firstHalt } from "./hook-runner.js";
import type { HookExecutionSummary } from "./hook-types.js";

describe("extractHalt", () => {
  it("returns the message when the reserved key carries a non-empty string", () => {
    expect(extractHalt({ [HOOK_HALT_KEY]: { message: "closed" } })).toEqual({ message: "closed" });
  });

  it("returns undefined for a normal result", () => {
    expect(extractHalt({ ok: true, data: 1 })).toBeUndefined();
    expect(extractHalt("pong")).toBeUndefined();
    expect(extractHalt(null)).toBeUndefined();
  });

  it("returns undefined when message is missing or empty (malformed → no halt)", () => {
    expect(extractHalt({ [HOOK_HALT_KEY]: {} })).toBeUndefined();
    expect(extractHalt({ [HOOK_HALT_KEY]: { message: "" } })).toBeUndefined();
    expect(extractHalt({ [HOOK_HALT_KEY]: { message: 42 } })).toBeUndefined();
  });
});

describe("firstHalt", () => {
  const base: HookExecutionSummary = {
    hookId: "h", event: "message_received", actionType: "tool",
    toolName: "t", success: true, durationMs: 1,
  };

  it("returns the first summary's halt", () => {
    const summaries: HookExecutionSummary[] = [
      { ...base, hookId: "a" },
      { ...base, hookId: "b", halt: { message: "stop" } },
    ];
    expect(firstHalt(summaries)).toEqual({ message: "stop" });
  });

  it("returns undefined when no summary halts", () => {
    expect(firstHalt([base])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- hook-halt`
Expected: FAIL — `extractHalt`/`firstHalt`/`HOOK_HALT_KEY` not exported.

- [ ] **Step 3: Add the contract to `hook-types.ts`**

At the top of `packages/engine/src/hooks/hook-types.ts` (after the existing imports), add:

```ts
/** Reserved key a tool returns to halt the pipeline and supply a system-authored reply. */
export const HOOK_HALT_KEY = "__haltPipeline" as const;

/** Payload of a halt: the message delivered to the user in place of the LLM turn. */
export interface HookHaltSignal {
  message: string;
}

/**
 * Read a halt signal from a tool's (unknown) result. Malformed shapes — missing
 * key, non-object, empty/non-string message — yield undefined so a buggy tool
 * never produces an empty reply. Contract-agnostic: works with any tool result.
 */
export function extractHalt(result: unknown): HookHaltSignal | undefined {
  if (!result || typeof result !== "object") return undefined;
  const raw = (result as Record<string, unknown>)[HOOK_HALT_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const message = (raw as Record<string, unknown>).message;
  if (typeof message !== "string" || message.trim() === "") return undefined;
  return { message };
}
```

Then add `halt?` to both `HookExecutionCapture` and `HookExecutionSummary`:

```ts
export interface HookExecutionCapture {
  args?: Record<string, unknown>;
  result?: string;
  /** Set when the executed tool requested a pipeline halt. */
  halt?: HookHaltSignal;
}
```

```ts
export interface HookExecutionSummary {
  hookId: string;
  event: HookEvent;
  actionType: HookActionType;
  toolName: string;
  success: boolean;
  error?: string;
  durationMs: number;
  args?: Record<string, unknown>;
  result?: string;
  /** Present when this hook's tool requested a halt (first halt wins). */
  halt?: HookHaltSignal;
}
```

- [ ] **Step 4: Add `firstHalt` to `hook-runner.ts`**

In `packages/engine/src/hooks/hook-runner.ts`, extend the type import and add the helper after the imports:

```ts
import type {
  HookActionExecutor,
  HookActionType,
  HookEvent,
  HookEventPayload,
  HookExecutionCapture,
  HookExecutionSummary,
  HookHaltSignal,
  HookRunContext,
  InstanceHookRow,
} from "./hook-types.js";

/** First halt requested across a run's summaries, or undefined. */
export function firstHalt(summaries: HookExecutionSummary[]): HookHaltSignal | undefined {
  return summaries.find((s) => s.halt)?.halt;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- hook-halt`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/hooks/hook-types.ts packages/engine/src/hooks/hook-runner.ts packages/engine/src/hooks/hook-halt.test.ts
git commit -F - <<'EOF'
feat(hooks): add halt-and-respond contract (HOOK_HALT_KEY, extractHalt, firstHalt)

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 2: Tool-action detects the halt signal (post-SDK contract)

**Files:**
- Modify: `packages/engine/src/hooks/actions/tool-action.ts` (locate by symbol — SDK branch changed line numbers)
- Test: `packages/engine/src/hooks/actions/tool-action.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tool-action.test.ts`, reusing its ACTUAL helpers (`hookFor(toolName, args)`, the hoisted `registryMock`, the `executeMock`, and the `capture`/`captured` pair defined in the `describe` block). New case:

```ts
it("should_capture_halt_when_result_carries_HOOK_HALT_KEY", async () => {
  executeMock.mockResolvedValue({ [HOOK_HALT_KEY]: { message: "we are closed" } });
  await toolActionExecutor.execute(hookFor("lookup", { query: "x" }), payload, ctx, capture);
  expect(captured.halt).toEqual({ message: "we are closed" });
});
```

Add `import { HOOK_HALT_KEY } from "../hook-types.js";` to the test's imports (`HookExecutionCapture` is already imported there). No new helpers — the file already defines `executeMock`, `capture`, `captured`, `hookFor`, `payload`, `ctx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- tool-action`
Expected: FAIL — `captured.halt` is `undefined`.

- [ ] **Step 3: Detect the halt in the executor**

In `packages/engine/src/hooks/actions/tool-action.ts`, import `extractHalt` and report it right after the tool executes. The post-merge executor ends with:

```ts
    capture({ args: r.value as Record<string, unknown> });
    const result = await def.execute(r.value, toolCtx);
    capture({ result: serializeResult(result) });
```

Change the import line to include `extractHalt`:

```ts
import { extractHalt } from "../hook-types.js";
```

and the tail to:

```ts
    capture({ args: r.value as Record<string, unknown> });
    const result = await def.execute(r.value, toolCtx);
    const halt = extractHalt(result);
    if (halt) capture({ halt });
    capture({ result: serializeResult(result) });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- tool-action`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/hooks/actions/tool-action.ts packages/engine/src/hooks/actions/tool-action.test.ts
git commit -F - <<'EOF'
feat(hooks): tool-action reports a halt signal from the tool result

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 3: Hook runner stops the chain on halt

**Files:**
- Modify: `packages/engine/src/hooks/hook-runner.ts:82-118` (the summary push + telemetry tail of the loop)
- Test: `packages/engine/src/hooks/hook-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `hook-runner.test.ts` (its harness already mocks `getEnabledHooks` via `getEnabledHooksMock` and the executor via `executeMock`):

```ts
it("stops the chain and surfaces the halt when a hook requests it", async () => {
  getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
  // First hook halts; capture is the 4th arg of execute(hook, payload, ctx, capture).
  executeMock.mockImplementationOnce(async (_h, _p, _c, capture) => {
    capture({ halt: { message: "stop" } });
  });

  const summaries = await runHooks("message_received", payload, baseCtx);

  expect(executeMock).toHaveBeenCalledTimes(1); // second hook never ran
  expect(summaries).toHaveLength(1);
  expect(summaries[0].halt).toEqual({ message: "stop" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- hook-runner`
Expected: FAIL — `executeMock` called twice; `summaries[0].halt` undefined.

- [ ] **Step 3: Wire halt into the loop**

In `hook-runner.ts`, include `halt` on the pushed summary and break after telemetry. The push currently reads:

```ts
    summaries.push({
      hookId: hook.id,
      event,
      actionType: hook.actionType,
      toolName,
      success,
      error,
      durationMs,
      args: captured.args,
      result: captured.result,
    });
```

Add `halt: captured.halt,` to that object. Then, after the `recordHookExecution({...}).catch(...)` call and before the loop's closing brace, add:

```ts
    // First halt wins: stop remaining hooks for this event. Telemetry/audit for
    // the halting hook is already recorded above. Post-LLM callers ignore the
    // halt (runPipelinePost never reads it) — the break only keeps behaviour
    // predictable across events.
    if (captured.halt) break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- hook-runner`
Expected: PASS. Re-run the full hooks suite: `npm run test:unit -w @polyant/engine -- hooks` — all green.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/hooks/hook-runner.ts packages/engine/src/hooks/hook-runner.test.ts
git commit -F - <<'EOF'
feat(hooks): stop the hook chain on the first halt

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 4: Pipeline — surface `shortCircuit` + un-suppress synthetic channels

**Files:**
- Modify: `packages/engine/src/pipeline.ts` (`buildHookPayload` ~295-310; `PipelinePreResult` ~488-495; `runPipelinePre` ~497-531)
- Test: `packages/engine/src/pipeline.hook-payload.test.ts` (Create)

- [ ] **Step 1: Write the failing test (un-suppression)**

Create `packages/engine/src/pipeline.hook-payload.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildHookPayload } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";
import type { PipelineContext } from "./pipeline.js";

function ctxFor(channel: string): PipelineContext {
  return {
    instanceId: asInstanceSlug("demo"),
    conversationId: "c1",
    isAutoTaskTurn: false,
    channelIdentity: { channel, channelId: "id1", userName: "u" },
  } as unknown as PipelineContext;
}

describe("buildHookPayload synthetic-channel inclusion", () => {
  it("builds a payload for scheduled and agent channels (no longer suppressed)", () => {
    expect(buildHookPayload(ctxFor("scheduled"), "hi")?.channel.type).toBe("scheduled");
    expect(buildHookPayload(ctxFor("agent"), "hi")?.channel.type).toBe("agent");
  });

  it("still suppresses auto-task turns", () => {
    const ctx = { ...ctxFor("whatsapp"), isAutoTaskTurn: true } as unknown as PipelineContext;
    expect(buildHookPayload(ctx, "hi")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- pipeline.hook-payload`
Expected: FAIL — scheduled/agent currently return `undefined`.

- [ ] **Step 3: Un-suppress synthetic channels in `buildHookPayload`**

In `pipeline.ts`, remove the synthetic-channel guard from `buildHookPayload`. Delete this line:

```ts
  if (INBOUND_SUPPRESSED_CHANNELS.has(ctx.channelIdentity.channel)) return undefined;
```

and update the doc comment above the function to:

```ts
/**
 * Build the hook event payload, or undefined when hooks must not fire:
 * auto-task turns and turns without a channel identity. Synthetic channels
 * (scheduled/agent) DO run hooks — only auto-tasks are excluded. `room`/webhook
 * are supervise-direct and wire hooks in their own engines.
 */
```

(Leave `INBOUND_SUPPRESSED_CHANNELS` and its other three uses — activity emits + `_channel` seed — untouched.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- pipeline.hook-payload`
Expected: PASS.

- [ ] **Step 5: Add `shortCircuit` to `PipelinePreResult` and `runPipelinePre`**

In `pipeline.ts`, import `firstHalt`:

```ts
import { runHooks, firstHalt } from "./hooks/hook-runner.js";
```

Add the field to `PipelinePreResult`:

```ts
export interface PipelinePreResult {
  ctx: PipelineContext;
  contextPrepMs: number;
  messageText: string;
  hookExecutions: HookExecutionSummary[];
  /** Set when a pre-LLM hook requested a halt: the LLM call is skipped and this text is the reply. */
  shortCircuit?: { text: string };
}
```

In `runPipelinePre`, after the hooks run and before the tool-results-in-history block, derive the short-circuit and return it. Change the final `return`:

```ts
  const halt = firstHalt(hookExecutions);

  if (ctx.instanceConfig.toolResultsInHistoryEnabled) {
    const hookMessages = hookExecutionsToModelMessages(hookExecutions);
    if (hookMessages.length > 0) ctx.history = [...(ctx.history ?? []), ...hookMessages];
  }

  return {
    ctx,
    contextPrepMs,
    messageText: msg.text,
    hookExecutions,
    shortCircuit: halt ? { text: halt.message } : undefined,
  };
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/pipeline.ts packages/engine/src/pipeline.hook-payload.test.ts
git commit -F - <<'EOF'
feat(hooks): surface pre-LLM halt as shortCircuit; run hooks on synthetic channels

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 5: `handleMessage` short-circuits

**Files:**
- Modify: `packages/engine/src/index.ts:198-201` (right after `const { ctx, contextPrepMs, messageText } = pre;`)

- [ ] **Step 1: Add the short-circuit block**

In `handleMessage`, immediately after `const { ctx, contextPrepMs, messageText } = pre;`, insert:

```ts
    // Pre-LLM hook halt: skip the LLM entirely and persist the canned reply as
    // the assistant message (full turn — runPipelinePost runs post-LLM hooks +
    // memory/summary and respects the abort/commit gate).
    if (pre.shortCircuit) {
      const { finalText } = await runPipelinePost({
        ctx,
        contextPrepMs,
        messageText,
        channel: msg.channelType,
        resultText: pre.shortCircuit.text,
        preHookExecutions: pre.hookExecutions,
        usage: { promptTokens: 0, completionTokens: 0 },
        durationMs: 0,
        toolBuildingMs: 0,
        isStreaming: false,
        abortSignal,
      });
      return { text: finalText };
    }
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS (all `runPipelinePost` required fields provided).

- [ ] **Step 3: Manual/integration verification**

`handleMessage` is a closure in `main()` — verify by running the engine:
1. Configure an instance with a hook on `message_received` whose tool returns `{ [HOOK_HALT_KEY]: { message: "HALTED" } }`.
2. Send a message via `/v1/chat/completions` (or Telegram).
3. Expect the reply text `HALTED`, persisted as the assistant message, and **no** LLM call in the logs (no supervisor token line).

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/index.ts
git commit -F - <<'EOF'
feat(hooks): short-circuit handleMessage on a pre-LLM halt

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 6: `handleMessageStream` short-circuits

**Files:**
- Modify: `packages/engine/src/index.ts:287-288` (right after `const { ctx, contextPrepMs, messageText } = pre;` in the streaming handler)

- [ ] **Step 1: Add the short-circuit block**

In `handleMessageStream`, immediately after `const { ctx, contextPrepMs, messageText } = pre;`, insert (mirrors the opt-out/missing-key single-chunk pattern already in this file):

```ts
    // Pre-LLM hook halt: emit the canned reply as a single-chunk stream and
    // persist it via runPipelinePost (post-LLM hooks + memory/summary run).
    if (pre.shortCircuit) {
      const canned = pre.shortCircuit.text;
      const haltMessageId = randomUUID();
      const completed = runPipelinePost({
        ctx,
        contextPrepMs,
        messageText,
        channel: msg.channelType,
        resultText: canned,
        preHookExecutions: pre.hookExecutions,
        assistantMessageId: haltMessageId,
        usage: { promptTokens: 0, completionTokens: 0 },
        durationMs: 0,
        toolBuildingMs: 0,
        isStreaming: true,
        abortSignal,
      }).then(({ finalText, hookExecutions }) => ({ text: finalText, hookExecutions }));

      return {
        textStream: (async function* () { yield canned; })(),
        fullStream: (async function* () { yield { type: "text-delta", text: canned }; })(),
        completed,
        meta: { conversationId: ctx.conversationId, messageId: haltMessageId },
        hookExecutions: pre.hookExecutions,
      };
    }
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS (return shape matches `StreamOutgoingMessage`; `randomUUID` already imported at the top of `index.ts`).

- [ ] **Step 3: Manual/integration verification**

1. Same halting hook as Task 5.
2. Call `POST /api/instances/:slug/chat/stream` (the native typed-SSE endpoint used by the playground).
3. Expect a single `text-delta` with the canned text, then `done` carrying `{ conversationId, messageId }`; the turn is persisted; no supervisor tokens logged.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/index.ts
git commit -F - <<'EOF'
feat(hooks): short-circuit handleMessageStream on a pre-LLM halt

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 7: Room engine halt

**Files:**
- Modify: `packages/engine/src/room/room-engine.ts` (imports ~1-19; supervise block ~139-188; trace ~225-237)
- Test: `packages/engine/src/room/room-engine.test.ts`

- [ ] **Step 1: Write the failing test**

`room-engine.test.ts` already hoists mocks for `supervise`, `conversationStore`, `traceStore`, etc. Add two new mocks near the others:

```ts
// add to vi.hoisted destructuring + object:
  mockRunHooks: vi.fn(),
  mockChannelManager: { sendOutbound: vi.fn() },
```

```ts
// add alongside the other vi.mock calls:
vi.mock("../hooks/hook-runner.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runHooks: mockRunHooks,
}));
vi.mock("../channels/channel-manager.js", () => ({ channelManager: mockChannelManager }));
```

Default `mockRunHooks.mockResolvedValue([])` in `beforeEach` (no halt). Then the new test:

```ts
it("halts the cycle without calling supervise and sends the canned reply outbound", async () => {
  // room config carries outbound channel/target; adjust to the test's room fixture.
  mockRunHooks.mockResolvedValue([
    { hookId: "h", event: "message_received", actionType: "tool", toolName: "gate",
      success: true, durationMs: 1, halt: { message: "closed for maintenance" } },
  ]);

  await executeRoomCycle(roomFixture, asInstanceSlug("demo"), undefined);

  expect(mockSupervise).not.toHaveBeenCalled();
  expect(mockChannelManager.sendOutbound).toHaveBeenCalledWith(
    asInstanceSlug("demo"), roomFixture.outboundChannel, roomFixture.outboundTarget, "closed for maintenance",
  );
  expect(mockConversationStore.appendMessages).toHaveBeenCalledWith(
    expect.any(String),
    [expect.objectContaining({ role: "assistant", content: "closed for maintenance" })],
  );
});
```

(Use the file's existing room fixture; ensure it has `outboundChannel`/`outboundTarget` set.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- room-engine`
Expected: FAIL — supervise still called; sendOutbound not called.

- [ ] **Step 3: Add imports**

In `room-engine.ts`, change the supervise import and add hooks + channel-manager:

```ts
import { supervise, type SupervisorOutput } from "../agents/supervisor/index.js";
import { runHooks, firstHalt } from "../hooks/hook-runner.js";
import type { HookEventPayload, HookRunContext } from "../hooks/hook-types.js";
import { channelManager } from "../channels/channel-manager.js";
```

- [ ] **Step 4: Gate supervise on the halt**

Replace the current `let result; try { result = await supervise({...}); } catch (...) {...}` region (lines ~139-177) and the assistant-persist that follows with:

```ts
  // Pre-LLM hook (halt-capable). Room is supervise-direct, so wire it manually.
  // Only message_received fires here (see spec §6).
  const hookPayload: HookEventPayload = {
    instance: { slug: instanceSlug },
    conversation: { id: conversationId },
    channel: { type: room.outboundChannel ?? "room", id: room.outboundTarget ?? "" },
    user: { name: "room" },
    message: { text: messageToSupervise },
  };
  const hookCtx: HookRunContext = {
    instanceId: instanceSlug,
    conversationId,
    secrets: instanceConfig.secrets,
    apiKeys: instanceConfig.apiKeys,
    provider: instanceConfig.provider,
  };
  const halt = firstHalt(await runHooks("message_received", hookPayload, hookCtx));

  let result: SupervisorOutput | undefined;
  if (!halt) {
    try {
      result = await supervise({
        message: messageToSupervise,
        conversationHistory: history,
        instanceId: instanceSlug,
        conversationId,
        provider: instanceConfig.provider,
        model: instanceConfig.model,
        apiKeys: instanceConfig.apiKeys,
        secrets: instanceConfig.secrets,
        memoryEnabled: instanceConfig.memoryEnabled,
        thinkingEnabled: instanceConfig.thinkingEnabled,
        debugEnabled: instanceConfig.debugEnabled,
        includeHarness: new Set(["room"]),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      roomLog.error("RoomCycle", `supervise() failed for ${instanceSlug}`, err);
      if (pendingEventIds.length > 0) {
        await markEventsCompleted(pendingEventIds, `ERROR: ${errorMsg.slice(0, 400)}`, room.instanceId).catch((e) =>
          roomLog.error("RoomCycle", "Failed to mark events completed after error", e),
        );
      }
      const errNow = new Date();
      const errTimestamp = errNow.toLocaleTimeString(config.datetime.locale, { hour: "2-digit", minute: "2-digit", timeZone: config.datetime.timezone });
      const errTriggers: string[] = [];
      if (pendingEvents.length > 0) errTriggers.push(`${pendingEvents.length} event(s)`);
      if (humanMessage) errTriggers.push("human message");
      const errContent = `———— ${errTimestamp} | ${errTriggers.join(" + ")} | ERROR ————\n${errorMsg.slice(0, 500)}`;
      await appendDailyLog(room.instanceId, errContent, pendingEvents.length)
        .catch((e) => roomLog.error("RoomCycle", "Failed to write error to activity log", e));
      return;
    }
  }

  const finalText = halt ? halt.message : result!.text;

  // On halt, deliver the canned reply to the room's outbound channel — room never
  // auto-sends (the agent uses room_send_message). Best-effort.
  if (halt && room.outboundChannel && room.outboundTarget) {
    try {
      await channelManager.sendOutbound(instanceSlug, room.outboundChannel, room.outboundTarget, finalText);
    } catch (err) {
      roomLog.error("RoomCycle", `halt send failed for ${instanceSlug}`, err);
    }
  }

  await conversationStore.appendMessages(conversationId, [
    { role: "assistant", content: finalText, steps: result?.steps, ...(result?.reasoning ? { reasoning: result.reasoning } : {}), ...(result?.debugPayload ? { debugPayload: result.debugPayload } : {}) },
  ]);

  if (pendingEventIds.length > 0) {
    await markEventsCompleted(pendingEventIds, finalText.slice(0, 500), room.instanceId);
  }
```

- [ ] **Step 5: Guard the trace record**

The `traceStore.record({...})` at the end reads `result.*`. Make them halt-safe:

```ts
  traceStore.record({
    conversationId,
    instanceId: instanceSlug,
    channel: "room",
    contextPrepMs,
    toolBuildingMs: result?.toolBuildingMs ?? 0,
    llmCallMs: result?.durationMs ?? 0,
    totalMs: Date.now() - cycleStart,
    promptTokens: result?.usage?.promptTokens ?? 0,
    completionTokens: result?.usage?.completionTokens ?? 0,
    toolCalls: result?.toolCallTraces,
    isStreaming: false,
  });
```

- [ ] **Step 6: Run test + typecheck**

Run: `npm run test:unit -w @polyant/engine -- room-engine`
Expected: PASS.
Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/room/room-engine.ts packages/engine/src/room/room-engine.test.ts
git commit -F - <<'EOF'
feat(hooks): honor pre-LLM halt in the room engine

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 8: Webhook engine halt

**Files:**
- Modify: `packages/engine/src/webhooks/webhook-engine.ts` (imports ~1-18; supervise block ~167-213; trace ~260-272)
- Test: `packages/engine/src/webhooks/webhook-engine.test.ts`

- [ ] **Step 1: Write the failing test**

Mirror Task 7's mock additions in `webhook-engine.test.ts` (`channelManager` is likely already mocked here — reuse it; add the `runHooks` mock). New test:

```ts
it("halts the trigger without calling supervise and sends the canned reply", async () => {
  mockRunHooks.mockResolvedValue([
    { hookId: "h", event: "message_received", actionType: "tool", toolName: "gate",
      success: true, durationMs: 1, halt: { message: "not now" } },
  ]);

  await triggerConversation(definitionFixture /* hasChannel + outboundTarget */);

  expect(mockSupervise).not.toHaveBeenCalled();
  expect(mockChannelManager.sendOutbound).toHaveBeenCalledWith(
    expect.anything(), definitionFixture.outboundChannel, expect.any(String), "not now",
  );
});
```

(Match `triggerConversation`'s real argument list in the test file. Default `mockRunHooks.mockResolvedValue([])` in `beforeEach`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- webhook-engine`
Expected: FAIL — supervise still called.

- [ ] **Step 3: Add imports**

```ts
import { supervise, type SupervisorOutput } from "../agents/supervisor/index.js";
import { runHooks, firstHalt } from "../hooks/hook-runner.js";
import type { HookEventPayload, HookRunContext } from "../hooks/hook-types.js";
```

- [ ] **Step 4: Gate supervise on the halt**

Replace the `let result; try { result = await supervise({...}); } catch (...) {...}` region (~167-193) with:

```ts
  const hookPayload: HookEventPayload = {
    instance: { slug: instanceSlug },
    conversation: { id: conversationId },
    channel: { type: definition.outboundChannel ?? "webhook", id: renderedTarget ?? "" },
    user: { name: definition.name },
    message: { text: messageToSupervise },
  };
  const hookCtx: HookRunContext = {
    instanceId: instanceSlug,
    conversationId,
    secrets: instanceConfig.secrets,
    apiKeys: instanceConfig.apiKeys,
    provider: instanceConfig.provider,
    state: stateBuffer.api(),
  };
  const halt = firstHalt(await runHooks("message_received", hookPayload, hookCtx));

  let result: SupervisorOutput | undefined;
  if (!halt) {
    try {
      result = await supervise({
        message: messageToSupervise,
        instanceId: instanceSlug,
        conversationId,
        conversationSummary: undefined,
        contextPrompt: safeContextPrompt,
        channelIdentity: hasChannel && renderedTarget
          ? { channel: definition.outboundChannel!, channelId: renderedTarget }
          : undefined,
        provider: instanceConfig.provider,
        model: instanceConfig.model,
        apiKeys: instanceConfig.apiKeys,
        secrets: instanceConfig.secrets,
        memoryEnabled: instanceConfig.memoryEnabled,
        knowledgeEnabled: instanceConfig.knowledgeEnabled,
        thinkingEnabled: instanceConfig.thinkingEnabled,
        debugEnabled: instanceConfig.debugEnabled,
        includeHarness: harnessCategories,
        stateBuffer,
      });
    } catch (err) {
      webhookLog.error("TriggerEngine", `supervise() failed for "${definition.name}"`, err);
      if (hasChannel) clearTriggerContext(conversationId);
      return;
    }
  }
```

- [ ] **Step 5: Make the tail halt-safe**

The state flush stays as-is (a halting hook's state writes must still commit). Update `finalText`, the assistant persist, the outbound send, and the trace:

```ts
  const finalText = halt
    ? halt.message
    : (result!.replyHandled && result!.replyText ? result!.replyText : result!.text);

  await conversationStore.appendMessages(conversationId, [
    { role: "assistant", content: finalText, steps: result?.steps, ...(result?.reasoning ? { reasoning: result.reasoning } : {}), ...(result?.debugPayload ? { debugPayload: result.debugPayload } : {}) },
  ]);

  if (hasChannel && finalText && !result?.replyHandled) {
    try {
      await channelManager.sendOutbound(instanceSlug, definition.outboundChannel!, renderedTarget!, finalText);
      webhookLog.info("TriggerEngine", `sent to ${definition.outboundChannel}:${renderedTarget}`);
    } catch (err) {
      webhookLog.error("TriggerEngine", `send failed for ${definition.outboundChannel}:${renderedTarget}`, err);
    }
  } else if (hasChannel && result?.replyHandled) {
    webhookLog.info("TriggerEngine", `reply already handled by tool — skipping free-form send for ${definition.outboundChannel}:${renderedTarget}`);
  }
```

And the trace:

```ts
  traceStore.record({
    conversationId,
    instanceId: instanceSlug,
    channel: channelLabel,
    contextPrepMs,
    toolBuildingMs: result?.toolBuildingMs ?? 0,
    llmCallMs: result?.durationMs ?? 0,
    totalMs: Date.now() - cycleStart,
    promptTokens: result?.usage?.promptTokens ?? 0,
    completionTokens: result?.usage?.completionTokens ?? 0,
    toolCalls: result?.toolCallTraces,
    isStreaming: false,
  });
```

- [ ] **Step 6: Run test + typecheck**

Run: `npm run test:unit -w @polyant/engine -- webhook-engine`
Expected: PASS.
Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/webhooks/webhook-engine.ts packages/engine/src/webhooks/webhook-engine.test.ts
git commit -F - <<'EOF'
feat(hooks): honor pre-LLM halt in the webhook engine

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 9: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` (the "Conversation lifecycle hooks" bullet)

- [ ] **Step 1: Document the mechanism**

Append to the hooks bullet in `CLAUDE.md`:

> **Halt-and-respond:** a hook tool may return `{ [HOOK_HALT_KEY]: { message } }` to interrupt the pipeline before the LLM runs and deliver `message` as the assistant reply (persisted like an LLM turn). Only the pre-LLM event `message_received` (and `conversation_start` on the conversational path) can halt; the runner stops at the first halt. Wired into every LLM entry point: `handleMessage`/`handleMessageStream` (real channels + scheduled + agent-call, which are now un-suppressed in `buildHookPayload`), plus the supervise-direct Room and Webhook engines. `HOOK_HALT_KEY`/`HookHaltSignal`/`extractHalt` live in `hooks/hook-types.ts` (promote to `@polyant-ai/plugin-sdk` when external plugin tools need to halt). Spec: `docs/superpowers/specs/2026-07-02-hook-halt-and-respond-design.md`.

- [ ] **Step 2: Full verification**

Run each and confirm green:

```bash
npm run typecheck -w @polyant/engine
npm run lint -w @polyant/engine
npm run test:unit -w @polyant/engine
```

Expected: all PASS. If lint flags the new `let result` in the engines, confirm it is genuinely reassigned (it is — only in the non-halt branch) and leave as-is.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -F - <<'EOF'
docs(hooks): document halt-and-respond across all LLM flows

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Self-Review notes (author)

- **Spec coverage:** contract (§4) → Task 1–2; runner break (§5.2) → Task 3; Path A un-suppress + shortCircuit (§5) → Task 4–6; Path B room/webhook (§6) → Task 7–8; SDK/trust (§8) → Pre-req + Task 2 + Task 9 doc; edge cases (§7: malformed → Task 1 `extractHalt`; post-LLM ignored → Task 3 comment).
- **Deferred cross-repo item:** SDK promotion of `HOOK_HALT_KEY` is explicitly a follow-up, not a task here.
- **Type consistency:** `firstHalt`, `extractHalt`, `HOOK_HALT_KEY`, `HookHaltSignal`, `shortCircuit.text`, `SupervisorOutput` used identically across tasks.
- **Behaviour change flagged:** Task 4 enables the full hook lifecycle for scheduled/agent — called out in the spec (§5.1) and the CLAUDE.md note.
