# Hook `regenerate` (LLM turn replay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `response_generated` hook ask the engine to replay the real supervisor turn (system prompt + tools), for any reason the hook decides.

**Architecture:** Add a `regenerate` control return to the hook contract (twin of `replaceResponse`, gated by `mutatesResponse: true`). The engine exposes a `regenerationCount` on the hook payload so the hook owns the stop condition; a pure, generic `generateWithReplay` loop drives re-generation up to a hard safety cap, and `response_generated` hook execution is extracted out of `runPipelinePost` so the loop runs before persistence.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), NestJS engine, Vitest, `@polyant-ai/plugin-sdk` (git-dep, `prepare`-built).

## Global Constraints

- ESM only — every relative import ends in `.js`. Named exports only (no default exports), except a `*.tool.ts`/`*.hook.ts` default export (not relevant here).
- Repo artifacts (code, comments, commit messages) in English.
- Commits: conventional-commit subject + DCO sign-off. Use `git commit -s -m "<subject>" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"` (the `-s` adds `Signed-off-by`; separate `-m` flags avoid the multi-line-in-one-`-m` newline corruption in this shell).
- SDK contract lives in a SEPARATE working dir/repo: `/Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk`. Engine is the worktree: `/Users/paolovalletta/Desktop/projects/polyant-ai/polyant/.claude/worktrees/hook-enable-disable-feedback-5beb70`.
- Engine consumes the SDK as a git dep (`packages/engine/package.json`, currently `#v1.3.0`). During development the SDK is installed from a local path; the final task retags (`v1.4.0`) and repoints.
- `MAX_REGENERATIONS = 5` — engine safety net, not product logic.
- `regenerate` is honored ONLY on `response_generated` and ONLY when the hook declares `mutatesResponse: true` (same gate as `replaceResponse`).
- Vitest single-file run pattern (from monorepo/worktree root): `npm run test:unit -w @polyant/engine -- <relative/path.test.ts>`. SDK: run inside its dir.

---

### Task 1: SDK contract — `regenerate` return + `regenerationCount` payload

**Files:**
- Modify: `/Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk/src/hooks.ts`
- Test: `/Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk/src/hooks.contract.test.ts` (create)

**Interfaces:**
- Consumes: existing `defineHook`, `HookResult`, `HookEventPayload` from `./hooks.js`.
- Produces: `HookResult` gains `regenerate?: { reason?: string }`; `HookEventPayload.response` becomes `{ text: string; regenerationCount: number }`. No new named export (both are nested in already-exported types).

All commands for this task run inside `/Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk`.

- [ ] **Step 1: Write the failing type-contract test**

Create `src/hooks.contract.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { defineHook } from "./hooks.js";

describe("hook regenerate contract", () => {
  it("accepts a handler that reads regenerationCount and returns regenerate", () => {
    const def = defineHook({
      name: "regen-contract",
      description: "type-level contract exercise",
      mutatesResponse: true,
      handler: (ctx) => {
        const { text, regenerationCount } = ctx.payload.response!;
        if (text.length === 0) return;
        return regenerationCount < 2
          ? { regenerate: { reason: "exercise" } }
          : { replaceResponse: { message: "gave up" } };
      },
    });
    expect(def.name).toBe("regen-contract");
    expect(def.mutatesResponse).toBe(true);
  });
});
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck`
Expected: FAIL — `Property 'regenerationCount' does not exist on type '{ text: string; }'` and `Object literal may only specify known properties, and 'regenerate' does not exist in type '...'`.

- [ ] **Step 3: Add the two fields in `src/hooks.ts`**

In `HookEventPayload`, change the `response` field:

```ts
  /** Present only on response_generated / response_sent. */
  response?: { text: string; regenerationCount: number };
```

In the `HookResult` union object member, add `regenerate` after `replaceResponse`:

```ts
      /**
       * On `response_generated`: discard this output and REPLAY the real
       * supervisor turn (same system prompt + tools). Honored only when the hook
       * declares `mutatesResponse: true` (same gate/rationale as replaceResponse).
       * The hook owns the stop condition via `payload.response.regenerationCount`
       * (0 on the first pass); the engine enforces only a hard safety cap. If a
       * pass returns both `regenerate` and `replaceResponse`, `regenerate` wins
       * (the replacement is re-evaluated against the fresh output).
       */
      regenerate?: { reason?: string };
```

- [ ] **Step 4: Run typecheck + build + tests**

Run: `npm run typecheck && npm run build && npm test`
Expected: PASS (all three).

- [ ] **Step 5: Commit (SDK repo)**

```bash
git -C /Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk add src/hooks.ts src/hooks.contract.test.ts
git -C /Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk commit -s \
  -m "feat(hooks): add regenerate control return + payload regenerationCount" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> Do NOT tag/push yet — the tag is minted in Task 7 after the engine integration is validated.

---

### Task 2: Engine mirrors + `firstRegenerate` + local SDK install

**Files:**
- Modify: `packages/engine/src/hooks/hook-types.ts`
- Modify: `packages/engine/src/hooks/hook-runner.ts`
- Test: `packages/engine/src/hooks/hook-runner.test.ts`

**Interfaces:**
- Consumes: SDK `HookResult`/`HookEventPayload` (Task 1), built locally.
- Produces: `HookRegenerateSignal { reason?: string }`; `HookExecutionSummary.regenerate?` and `HookExecutionCapture.regenerate?`; `HookEventPayload.response` mirror gains `regenerationCount`; `firstRegenerate(summaries): HookRegenerateSignal | undefined`.

All engine commands run from the worktree root `/Users/paolovalletta/Desktop/projects/polyant-ai/polyant/.claude/worktrees/hook-enable-disable-feedback-5beb70`.

- [ ] **Step 1: Build the SDK and install it locally into the engine**

```bash
npm --prefix /Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk run build
npm install /Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk -w @polyant/engine
```

Expected: `packages/engine/package.json` now shows `"@polyant-ai/plugin-sdk": "file:../../../../../polyant-sdk"` (or an absolute `file:` path). This is temporary — Task 7 restores the git dep.

- [ ] **Step 2: Write the failing test for `firstRegenerate`**

Add to `packages/engine/src/hooks/hook-runner.test.ts` (reuse the existing `summary()` helper in that file):

```ts
import { firstRegenerate } from "./hook-runner.js";

describe("firstRegenerate", () => {
  it("returns the first regenerate signal across summaries", () => {
    expect(
      firstRegenerate([summary({}), summary({ regenerate: { reason: "dirty" } })]),
    ).toEqual({ reason: "dirty" });
  });
  it("returns undefined when no summary requested regenerate", () => {
    expect(firstRegenerate([summary({}), summary({})])).toBeUndefined();
  });
});
```

If the local `summary()` helper does not yet accept a `regenerate` field, extend its input type inline in the test file to include `regenerate?: { reason?: string }`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- src/hooks/hook-runner.test.ts`
Expected: FAIL — `firstRegenerate is not a function` (import unresolved).

- [ ] **Step 4: Update `hook-types.ts`**

Add the signal type next to `HookReplaceSignal`:

```ts
/** Payload of a regenerate request (post-LLM replay of the supervisor turn). */
export interface HookRegenerateSignal {
  reason?: string;
}
```

Update the local `HookEventPayload.response` mirror:

```ts
  /** Present only on response_generated / response_sent. */
  response?: { text: string; regenerationCount: number };
```

Add `regenerate?` to BOTH `HookExecutionSummary` and `HookExecutionCapture` (after their `replaceResponse?` field):

```ts
  /** Present when this hook requested a post-LLM turn replay. */
  regenerate?: HookRegenerateSignal;
```

- [ ] **Step 5: Add `firstRegenerate` in `hook-runner.ts`**

Import the type (extend the existing `import type { ... } from "./hook-types.js"` list with `HookRegenerateSignal`), then add next to `firstReplaceResponse`:

```ts
/** First regenerate requested across a run's summaries, or undefined. */
export function firstRegenerate(summaries: HookExecutionSummary[]): HookRegenerateSignal | undefined {
  return summaries.find((s) => s.regenerate)?.regenerate;
}
```

In the `summaries.push({ ... })` object inside `runHooks`, add:

```ts
      regenerate: captured.regenerate,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- src/hooks/hook-runner.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/package.json package-lock.json packages/engine/src/hooks/hook-types.ts packages/engine/src/hooks/hook-runner.ts packages/engine/src/hooks/hook-runner.test.ts
git commit -s \
  -m "feat(hooks): mirror regenerate signal + add firstRegenerate" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> Note: `package.json`/`package-lock.json` show the temporary local `file:` dep. Task 7 reverts it in its own commit.

---

### Task 3: `function-action` captures `regenerate`

**Files:**
- Modify: `packages/engine/src/hooks/actions/function-action.ts`
- Test: `packages/engine/src/hooks/actions/function-action.test.ts`

**Interfaces:**
- Consumes: `HookResult.regenerate` (SDK), `HookExecutionCapture.regenerate` (Task 2), `def.mutatesResponse`.
- Produces: executor calls `capture({ regenerate: { reason } })` when the handler returns `regenerate`, warning if `mutatesResponse` is not declared (mirrors `replaceResponse`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/engine/src/hooks/actions/function-action.test.ts` (mirror the existing `replaceResponse` tests):

```ts
it("should_capture_regenerate_and_warn_when_mutatesResponse_not_declared", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { promise, captured } = run(def({ mutatesResponse: false, handler: () => ({ regenerate: { reason: "dirty" } }) }));
  await promise;
  expect(captured.regenerate).toEqual({ reason: "dirty" });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("mutatesResponse"));
  warn.mockRestore();
});

it("should_capture_regenerate_without_warning_when_mutatesResponse_declared", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { promise, captured } = run(def({ mutatesResponse: true, handler: () => ({ regenerate: {} }) }));
  await promise;
  expect(captured.regenerate).toEqual({});
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -w @polyant/engine -- src/hooks/actions/function-action.test.ts`
Expected: FAIL — `captured.regenerate` is `undefined`.

- [ ] **Step 3: Add the capture in `function-action.ts`**

After the `injectContext` block (or after the `replaceResponse` block), add:

```ts
    if (result.regenerate) {
      // Same runtime gate as replaceResponse: regenerate mutates the turn, so it
      // is honored only on non-streamed (declare-and-buffer) turns.
      if (!def.mutatesResponse) {
        console.warn(
          `[hooks] "${functionName}" returned regenerate without declaring mutatesResponse:true — honored only on non-streamed turns.`,
        );
      }
      capture({ regenerate: { reason: result.regenerate.reason } });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -w @polyant/engine -- src/hooks/actions/function-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/hooks/actions/function-action.ts packages/engine/src/hooks/actions/function-action.test.ts
git commit -s \
  -m "feat(hooks): capture regenerate return in function action" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Pure replay loop — `generateWithReplay`

**Files:**
- Create: `packages/engine/src/hooks/response-replay.ts`
- Test: `packages/engine/src/hooks/response-replay.test.ts` (create)

**Interfaces:**
- Consumes: `HookExecutionSummary`, `HookReplaceSignal`, `HookRegenerateSignal` (types, Task 2).
- Produces:
  - `MAX_REGENERATIONS = 5`
  - `interface ResponseGeneratedOutcome { summaries: HookExecutionSummary[]; replace?: HookReplaceSignal; regenerate?: HookRegenerateSignal }`
  - `generateWithReplay<R extends { text: string }>(opts: { generate: (regen: number) => Promise<R>; evaluate: (text: string, regen: number) => Promise<ResponseGeneratedOutcome>; maxRegenerations: number; abortSignal?: AbortSignal }): Promise<{ result: R; finalText: string; outcome: ResponseGeneratedOutcome }>`

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/src/hooks/response-replay.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { generateWithReplay, MAX_REGENERATIONS, type ResponseGeneratedOutcome } from "./response-replay.js";

const clean: ResponseGeneratedOutcome = { summaries: [] };
const wantRegen: ResponseGeneratedOutcome = { summaries: [], regenerate: { reason: "dirty" } };

describe("generateWithReplay", () => {
  it("returns the first result when no hook asks to regenerate", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const { result, finalText, outcome } = await generateWithReplay({
      generate, evaluate: async () => clean, maxRegenerations: 5,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(0);
    expect(result.text).toBe("gen0");
    expect(finalText).toBe("gen0");
    expect(outcome).toBe(clean);
  });

  it("regenerates while requested, passing the incremented count", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const evaluate = vi.fn(async (_t: string, r: number) => (r < 2 ? wantRegen : clean));
    const { result, finalText } = await generateWithReplay({ generate, evaluate, maxRegenerations: 5 });
    expect(generate.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]);
    expect(result.text).toBe("gen2");
    expect(finalText).toBe("gen2");
  });

  it("stops at maxRegenerations even if the hook keeps asking", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const { result } = await generateWithReplay({
      generate, evaluate: async () => wantRegen, maxRegenerations: 2,
    });
    expect(generate).toHaveBeenCalledTimes(3); // initial + 2 replays
    expect(result.text).toBe("gen2");
  });

  it("applies replaceResponse when no regenerate is requested", async () => {
    const generate = vi.fn(async () => ({ text: "raw" }));
    const { finalText } = await generateWithReplay({
      generate,
      evaluate: async () => ({ summaries: [], replace: { message: "clean" } }),
      maxRegenerations: 5,
    });
    expect(finalText).toBe("clean");
  });

  it("prefers regenerate over replace within the same pass", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const evaluate = vi.fn(async (_t: string, r: number) =>
      r === 0 ? { summaries: [], regenerate: { reason: "x" }, replace: { message: "ignored" } } : clean,
    );
    const { finalText } = await generateWithReplay({ generate, evaluate, maxRegenerations: 5 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(finalText).toBe("gen1");
  });

  it("does not regenerate when the signal is already aborted", async () => {
    const generate = vi.fn(async (r: number) => ({ text: `gen${r}` }));
    const ac = new AbortController();
    ac.abort();
    await generateWithReplay({ generate, evaluate: async () => wantRegen, maxRegenerations: 5, abortSignal: ac.signal });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("exports a hard cap of 5", () => {
    expect(MAX_REGENERATIONS).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -w @polyant/engine -- src/hooks/response-replay.test.ts`
Expected: FAIL — cannot find module `./response-replay.js`.

- [ ] **Step 3: Create `response-replay.ts`**

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HookExecutionSummary, HookReplaceSignal, HookRegenerateSignal } from "./hook-types.js";

/** Engine safety net against a hook that always requests regenerate — NOT product logic.
 *  ponytail: constant; make per-instance only if a real case needs it. */
export const MAX_REGENERATIONS = 5;

/** Interpreted result of one round of `response_generated` hooks. */
export interface ResponseGeneratedOutcome {
  summaries: HookExecutionSummary[];
  replace?: HookReplaceSignal;
  regenerate?: HookRegenerateSignal;
}

/**
 * Generate, then let hooks evaluate the output and optionally request a replay
 * of the SAME generation (fresh supervisor turn). The stop condition is the
 * hook's (via the `regen` count passed to `evaluate`); this loop only enforces
 * `maxRegenerations` and the abort signal. `regenerate` takes precedence over
 * `replace` in a pass — the replacement is re-evaluated against the fresh output.
 */
export async function generateWithReplay<R extends { text: string }>(opts: {
  generate: (regen: number) => Promise<R>;
  evaluate: (text: string, regen: number) => Promise<ResponseGeneratedOutcome>;
  maxRegenerations: number;
  abortSignal?: AbortSignal;
}): Promise<{ result: R; finalText: string; outcome: ResponseGeneratedOutcome }> {
  const { generate, evaluate, maxRegenerations, abortSignal } = opts;
  let regen = 0;
  let result = await generate(regen);
  let outcome = await evaluate(result.text, regen);
  while (outcome.regenerate && regen < maxRegenerations && !abortSignal?.aborted) {
    regen += 1;
    result = await generate(regen);
    outcome = await evaluate(result.text, regen);
  }
  const finalText = outcome.replace?.message ?? result.text;
  return { result, finalText, outcome };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -w @polyant/engine -- src/hooks/response-replay.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/hooks/response-replay.ts packages/engine/src/hooks/response-replay.test.ts
git commit -s \
  -m "feat(hooks): pure generateWithReplay loop with hard cap" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Pipeline — payload count, `runResponseGeneratedHooks`, `runPipelinePost` opt-in

**Files:**
- Modify: `packages/engine/src/pipeline.ts`
- Test: `packages/engine/src/pipeline.test.ts` (create if absent)

**Interfaces:**
- Consumes: `ResponseGeneratedOutcome` (Task 4), `firstReplaceResponse`/`firstRegenerate` (Task 2), existing `buildHookPayload`/`buildHookRunContext`/`runHooks`.
- Produces:
  - `buildHookPayload(ctx, messageText, responseText?, regenerationCount = 0)` — sets `response.regenerationCount`.
  - `runResponseGeneratedHooks(ctx, messageText, responseText, regenerationCount, abortSignal?): Promise<ResponseGeneratedOutcome>`.
  - `PipelinePostOptions.responseGenerated?: ResponseGeneratedOutcome` — when set, `runPipelinePost` does NOT re-run `response_generated` hooks and does NOT re-apply replace (the caller already produced the final text).

- [ ] **Step 1: Write the failing test for `buildHookPayload` regenerationCount**

Create (or add to) `packages/engine/src/pipeline.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { buildHookPayload, type PipelineContext } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";

function ctx(): PipelineContext {
  return {
    pipelineStart: 0,
    instanceId: asInstanceSlug("acme"),
    conversationId: "acme:web:u1",
    conversationSummary: undefined,
    contextPrompt: undefined,
    channelIdentity: { channel: "web", channelId: "u1", userName: "Ada" },
    stateBuffer: undefined,
    history: undefined,
    isFirstTurn: true,
    hasOverflow: false,
    droppedMessages: undefined,
    instanceConfig: {} as PipelineContext["instanceConfig"],
    langsmith: undefined,
    userAttachments: undefined,
    incomingSystemMessages: undefined,
    isAutoTaskTurn: false,
    inboundMetadata: undefined,
  };
}

describe("buildHookPayload", () => {
  it("sets regenerationCount on response, defaulting to 0", () => {
    const p = buildHookPayload(ctx(), "hi", "out");
    expect(p?.response).toEqual({ text: "out", regenerationCount: 0 });
  });
  it("propagates a non-zero regenerationCount", () => {
    const p = buildHookPayload(ctx(), "hi", "out", 2);
    expect(p?.response).toEqual({ text: "out", regenerationCount: 2 });
  });
  it("omits response when no responseText is given", () => {
    const p = buildHookPayload(ctx(), "hi");
    expect(p?.response).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- src/pipeline.test.ts`
Expected: FAIL — `response` is `{ text: "out" }` (no `regenerationCount`), so `toEqual` mismatches.

- [ ] **Step 3: Update `buildHookPayload`**

Change the signature and the `response` spread:

```ts
export function buildHookPayload(
  ctx: PipelineContext,
  messageText: string,
  responseText?: string,
  regenerationCount = 0,
): HookEventPayload | undefined {
  if (ctx.isAutoTaskTurn || !ctx.channelIdentity) return undefined;
  return {
    instance: { slug: ctx.instanceId },
    conversation: { id: ctx.conversationId },
    channel: { type: ctx.channelIdentity.channel, id: ctx.channelIdentity.channelId },
    user: { name: ctx.channelIdentity.userName ?? "" },
    message: { text: messageText },
    ...(responseText !== undefined ? { response: { text: responseText, regenerationCount } } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- src/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `runResponseGeneratedHooks` and wire the imports**

Add to the imports at the top of `pipeline.ts`:

```ts
import { runHooks, firstHalt, firstReplaceResponse, firstRegenerate, collectInjectContext, hookProvenance, type HookProvenance } from "./hooks/hook-runner.js";
import type { ResponseGeneratedOutcome } from "./hooks/response-replay.js";
```

(Extend the existing `hook-runner.js` import — do not duplicate it — adding `firstRegenerate`.)

Add the exported helper (place it after `buildHookRunContext`):

```ts
/**
 * Run the `response_generated` hooks for one pass and interpret their outcome.
 * Extracted from runPipelinePost so the replay loop can run it BEFORE persistence.
 * Returns empty summaries when hooks must not fire (auto-task / no channel identity).
 */
export async function runResponseGeneratedHooks(
  ctx: PipelineContext,
  messageText: string,
  responseText: string,
  regenerationCount: number,
  abortSignal?: AbortSignal,
): Promise<ResponseGeneratedOutcome> {
  const payload = buildHookPayload(ctx, messageText, responseText, regenerationCount);
  if (!payload) return { summaries: [] };
  const hookCtx = buildHookRunContext(ctx, abortSignal);
  const summaries = await runHooks("response_generated", payload, hookCtx);
  return { summaries, replace: firstReplaceResponse(summaries), regenerate: firstRegenerate(summaries) };
}
```

- [ ] **Step 6: Make `runPipelinePost` accept pre-computed hooks**

Add to `PipelinePostOptions`:

```ts
  /** Pre-computed response_generated outcome (buffered replay path). When set,
   *  runPipelinePost does NOT re-run those hooks and does NOT re-apply replace —
   *  the caller already produced the final `resultText`. */
  responseGenerated?: ResponseGeneratedOutcome;
```

Replace the existing `response_generated` block in `runPipelinePost` (the `hookPayload`/`hookCtx` build + the `runHooks("response_generated", ...)` push + the `firstReplaceResponse` apply) with:

```ts
  const hookPayload = buildHookPayload(ctx, opts.messageText, finalText);
  const hookCtx = hookPayload ? buildHookRunContext(ctx, opts.abortSignal) : undefined;

  // Buffered replay path pre-runs response_generated (with the real count) and
  // has already folded any replace into resultText — reuse its summaries, do not
  // re-run or re-apply. Streaming/halt paths run them here (count 0), as before.
  if (opts.responseGenerated) {
    hookExecutions.push(...opts.responseGenerated.summaries);
  } else if (hookPayload && hookCtx) {
    const summaries = await runHooks("response_generated", hookPayload, hookCtx);
    hookExecutions.push(...summaries);
    const replace = firstReplaceResponse(summaries);
    if (replace) finalText = replace.message;
  }
  const provenance = hookProvenance(hookExecutions) ?? opts.provenance;
```

(The `response_sent` block below still uses `hookPayload`/`hookCtx` unchanged.)

- [ ] **Step 7: Run typecheck + the pipeline test**

Run: `npm run typecheck -w @polyant/engine && npm run test:unit -w @polyant/engine -- src/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/pipeline.ts packages/engine/src/pipeline.test.ts
git commit -s \
  -m "feat(hooks): extract runResponseGeneratedHooks + opt-in responseGenerated in runPipelinePost" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Wire the replay loop into `runBufferedTurn`

**Files:**
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Consumes: `generateWithReplay`, `MAX_REGENERATIONS` (Task 4); `runResponseGeneratedHooks` (Task 5); existing `supervise`, `runPipelinePost`.
- Produces: `runBufferedTurn` now regenerates the supervisor turn when a `response_generated` hook requests it, persisting once with the final text.

> This task is thin wiring; the testable logic (`generateWithReplay`, `runResponseGeneratedHooks`, `buildHookPayload`) is covered by Tasks 4–5. `runBufferedTurn` is a closure inside `index.ts` and is validated by typecheck/lint/build here plus the manual smoke test in Step 4. No new unit test — noted explicitly so the gap is not silent.

- [ ] **Step 1: Add imports**

Extend the pipeline import in `index.ts` with `runResponseGeneratedHooks`, and add a new import:

```ts
import { generateWithReplay, MAX_REGENERATIONS } from "./hooks/response-replay.js";
```

- [ ] **Step 2: Replace the supervise + post block in `runBufferedTurn`**

Replace the current body from `let result;` through the `const { finalText } = await runPipelinePost({ ... })` call (the non-halt branch) with:

```ts
    // Phase 3: Supervisor (LLM call + tool building), with response_generated
    // replay: a hook may discard the output and ask to re-run the real turn.
    const agentMeta = msg.metadata?.agentCall as AgentCallMetadata | undefined;
    const superviseArgs = {
      message: messageText,
      conversationHistory: ctx.history,
      instanceId: ctx.instanceId,
      conversationId: ctx.conversationId,
      conversationSummary: ctx.conversationSummary,
      contextPrompt: ctx.contextPrompt,
      channelIdentity: ctx.channelIdentity,
      provider: ctx.instanceConfig.provider,
      model: ctx.instanceConfig.model,
      apiKeys: ctx.instanceConfig.apiKeys,
      secrets: ctx.instanceConfig.secrets,
      langsmith: ctx.langsmith,
      memoryEnabled: ctx.instanceConfig.memoryEnabled,
      knowledgeEnabled: ctx.instanceConfig.knowledgeEnabled,
      thinkingEnabled: ctx.instanceConfig.thinkingEnabled,
      thinkingLevel: ctx.instanceConfig.thinkingLevel,
      temperature: ctx.instanceConfig.temperature ?? undefined,
      attachments: msg.attachments,
      abortSignal,
      agentCallDepth: agentMeta?.depth,
      agentCallMetadata: agentMeta,
      stateBuffer: ctx.stateBuffer,
      stateInPromptEnabled: ctx.instanceConfig.stateInPromptEnabled,
      datetimeInjectionEnabled: ctx.instanceConfig.datetimeInjectionEnabled,
      cacheConfig: ctx.instanceConfig.cacheConfig,
      debugEnabled: ctx.instanceConfig.debugEnabled,
      optoutHint:
        ctx.instanceConfig.optout.enabled && ctx.instanceConfig.optout.injectPromptHint
          ? { stopKeywords: ctx.instanceConfig.optout.stopKeywords, resumeKeywords: ctx.instanceConfig.optout.resumeKeywords }
          : undefined,
    };

    let replay;
    try {
      replay = await generateWithReplay({
        generate: () => supervise(superviseArgs),
        evaluate: (text, regen) => runResponseGeneratedHooks(ctx, messageText, text, regen, abortSignal),
        maxRegenerations: MAX_REGENERATIONS,
        abortSignal,
      });
    } catch (err) {
      if (isMissingApiKeyError(err)) {
        pipelineLog.response(ctx.instanceId, Date.now() - ctx.pipelineStart);
        return { text: MISSING_KEY_RESPONSE };
      }
      throw err;
    }
    const { result, finalText: replayText, outcome } = replay;
    if (outcome.regenerate) {
      console.warn(
        `[pipeline] ${ctx.conversationId}: regenerate still requested after MAX_REGENERATIONS=${MAX_REGENERATIONS} — delivering last output`,
      );
    }

    // Phase 4+5: Trace + afterResponse (skipped on abort). Pass the pre-computed
    // response_generated outcome so runPipelinePost neither re-runs those hooks
    // nor re-applies replace (replayText already reflects it).
    const { finalText } = await runPipelinePost({
      ctx,
      contextPrepMs,
      messageText,
      channel: msg.channelType,
      resultText: replayText,
      responseGenerated: outcome,
      steps: result.steps,
      reasoning: result.reasoning,
      debugPayload: result.debugPayload,
      assistantMessageId,
      toolCallTraces: result.toolCallTraces,
      usage: result.usage,
      model: result.model,
      provider: result.provider,
      cost: result.cost,
      thinking: result.thinking,
      temperature: result.temperature,
      durationMs: result.durationMs,
      toolBuildingMs: result.toolBuildingMs,
      isStreaming: false,
      abortSignal,
    });

    return {
      text: finalText,
      toolCalls: result.toolCallTraces?.map((t) => ({ name: t.name, durationMs: t.duration_ms })),
      usage: result.usage ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens } : undefined,
    };
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `npm run typecheck -w @polyant/engine && npm run lint -w @polyant/engine && npm run build:engine`
Expected: PASS (no errors).

- [ ] **Step 4: Manual smoke test (real replay)**

Create a temporary hook `packages/engine/src/hooks/regen-smoke.hook.ts`:

```ts
import { defineHook } from "@polyant-ai/plugin-sdk";
export default defineHook({
  name: "regen-smoke",
  description: "smoke: regenerate once then let it through",
  mutatesResponse: true,
  handler: (ctx) => {
    const { regenerationCount } = ctx.payload.response!;
    console.log(`[regen-smoke] pass regenerationCount=${regenerationCount}`);
    return regenerationCount < 1 ? { regenerate: { reason: "smoke" } } : undefined;
  },
});
```

Enable a `response_generated` hook pointing at `regen-smoke` on a dev instance (`POST /api/instances/:slug/hooks`), send one message via the playground, and confirm the logs show `regenerationCount=0` then `regenerationCount=1` (two supervisor calls), the turn is served non-streamed, and exactly one assistant row is persisted. Then DELETE the temp hook file and disable the hook.
Expected: two passes logged, single persisted turn.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/index.ts
git commit -s \
  -m "feat(hooks): replay the supervisor turn when a response_generated hook requests regenerate" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Ship the SDK tag and repoint the engine

**Files:**
- Modify: `packages/engine/package.json`
- Tag: `polyant-sdk` repo `v1.4.0`

- [ ] **Step 1: Bump + tag + push the SDK**

```bash
cd /Users/paolovalletta/Desktop/projects/polyant-ai/polyant-sdk
npm version 1.4.0 --no-git-tag-version
git add package.json package-lock.json
git commit -s -m "chore(release): v1.4.0 — regenerate hook contract" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git tag v1.4.0
git push origin HEAD --tags
```

Expected: tag `v1.4.0` pushed.

- [ ] **Step 2: Repoint the engine git dep**

Edit `packages/engine/package.json`, set:

```json
"@polyant-ai/plugin-sdk": "git+https://github.com/polyant-ai/polyant-sdk.git#v1.4.0",
```

Then, from the worktree root:

```bash
npm install
```

Expected: `package-lock.json` resolves the SDK to the `v1.4.0` git ref (no more local `file:` dep).

- [ ] **Step 3: Full engine gate**

Run: `npm run typecheck -w @polyant/engine && npm run lint -w @polyant/engine && npm run test:unit -w @polyant/engine && npm run build:engine`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/package.json package-lock.json
git commit -s \
  -m "chore(deps): repoint plugin-sdk to v1.4.0 (regenerate hook contract)" \
  -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Push the branch**

```bash
git push
```

Expected: branch `claude/llm-post-message-retry-hook-b574cc` updated. Open a PR against `develop` when ready.

---

## Self-Review

**Spec coverage:**
- §5 contract → Task 1 (SDK) + Task 2 (engine mirrors).
- §6.1 extract helper → Task 5. §6.2 loop → Task 4 (pure) + Task 6 (wiring). §6.3 `runPipelinePost` opt-in → Task 5.
- §7 precedence (regenerate wins) → `generateWithReplay` (Task 4) + test "prefers regenerate over replace".
- §8 `mutatesResponse` gate/warning → Task 3; scope (buffered only) → Task 6 wires only `runBufferedTurn` (streaming/halt paths use `runPipelinePost` without `responseGenerated`, count 0, no replay).
- §9 hard cap → Task 4 (`MAX_REGENERATIONS`, tests) + Task 6 warning at exhaustion.
- §10 telemetry → unchanged wiring; `ai_logs`/`hook_executions` already cover it; exhaustion log line in Task 6.
- §11 testing → Tasks 1–5 each ship tests; Task 6 gap called out explicitly.
- §12 delivery → Task 1 (commit only) + Task 2 (local install) + Task 7 (tag + repoint).

**Placeholder scan:** none — every code step shows complete code; the one manual step (Task 6 Step 4) is a labeled smoke test, not a TODO.

**Type consistency:** `ResponseGeneratedOutcome`, `generateWithReplay`, `MAX_REGENERATIONS`, `firstRegenerate`, `HookRegenerateSignal`, `runResponseGeneratedHooks`, and `PipelinePostOptions.responseGenerated` are used with the same names/signatures across Tasks 2, 4, 5, 6.
