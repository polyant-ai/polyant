# Conversation reset keyword (`RESET`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tester send `RESET` in any chat to archive the current conversation (rename with a random 5-digit suffix) and continue from an empty one, without the RESET turn itself being persisted anywhere.

**Architecture:** A first-party hook function on `message_received` matches the keyword, calls the existing `conversationStore.renameConversation`, and returns `halt` with a new `persist: false` flag. The engine honours that flag in `runPipelinePost` by skipping exactly the persistence side effects (trace, state flush, `afterResponse`, contextPrompt clear). No migration, no endpoint, no frontend change.

**Tech Stack:** TypeScript ESM, NestJS 11, Drizzle ORM, Vitest, `@polyant-ai/plugin-sdk` (separate repo, git-tag dependency).

Spec: [`docs/superpowers/specs/2026-07-29-conversation-reset-keyword-design.md`](../specs/2026-07-29-conversation-reset-keyword-design.md)

## Global Constraints

- Repo artifacts (code, comments, docs, commit messages) in **English**.
- Every commit needs `Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>` (DCO). Use `git commit -F <file>` — multi-line `-m` corrupts newlines in this shell.
- Engine PRs target **`develop`**, not `main`.
- ESM: every relative import ends in `.js`. Named exports only, except the `export default defineHook(...)` required by the hook loader.
- Files kebab-case, `{entity}.{type}.ts`. Hook function files must be named `*.hook.ts` to be discovered.
- The keyword is hardcoded `RESET`, matched as `text.trim().toUpperCase() === "RESET"`. No config, no secret.
- Archive suffix format: `` `${conversationId}#${5 digits}` `` (digits `10000`–`99999`, so the suffix is always 5 chars).
- `persist` defaults to `true` everywhere: absent flag ⇒ current behaviour, byte-for-byte.
- Two repos, strictly sequenced: SDK (`~/Desktop/projects/polyant-ai/polyant-sdk`) tag `v1.5.0` must exist before the engine tasks compile.

---

### Task 1: SDK — optional `persist` on the halt control return

**Repo:** `~/Desktop/projects/polyant-ai/polyant-sdk` (NOT the engine worktree).

**Files:**
- Modify: `src/hooks.ts` (the `HookResult` union, `halt` member)
- Modify: `package.json` (version `1.4.0` → `1.5.0`)
- Test: `src/hooks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HookResult["halt"]` is `{ message: string; persist?: boolean } | undefined`. Consumed by engine Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

Append to `src/hooks.test.ts`, inside the existing top-level `describe`:

```ts
it("a halt may opt out of persistence", async () => {
  const def = defineHook({
    name: "reset",
    description: "fixture reset hook",
    handler: () => ({ halt: { message: "RESET", persist: false } }),
  });
  const result = await def.handler({} as never);
  expect(result).toEqual({ halt: { message: "RESET", persist: false } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/hooks.test.ts`
Expected: FAIL — TypeScript error `Object literal may only specify known properties, and 'persist' does not exist in type '{ message: string; }'`.

- [ ] **Step 3: Write minimal implementation**

In `src/hooks.ts`, replace the `halt` member of the `HookResult` union (currently `halt?: { message: string };`) with:

```ts
      /**
       * Pre-LLM (conversation_start, message_received): skip the LLM, reply with this.
       *
       * `persist` (default `true`) controls whether the halted turn is persisted at
       * all. With `false` the engine records the hook execution but writes no user or
       * assistant message, no trace, no state flush and no summary/memory work — the
       * turn is ephemeral. Use it for command-style hooks (`RESET`, `/help`) whose
       * exchange must not pollute the model's history. Honored on the conversational
       * path; the supervise-direct Room/Webhook engines ignore it.
       */
      halt?: { message: string; persist?: boolean };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Full SDK verification**

Run: `npm run build && npm test`
Expected: build succeeds, all tests pass.

- [ ] **Step 6: Bump the version**

In `package.json`: `"version": "1.4.0"` → `"version": "1.5.0"`.

- [ ] **Step 7: Commit**

```bash
git add src/hooks.ts src/hooks.test.ts package.json
git commit -F /tmp/sdk-msg.txt
```

`/tmp/sdk-msg.txt`:

```
feat(hooks): add optional halt.persist to skip turn persistence

A pre-LLM halt may now return `persist: false`, telling the engine to
deliver the canned reply without persisting the turn (no message rows,
trace, state flush, summary or memory work). Defaults to true, so
existing hooks are unaffected.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

- [ ] **Step 8: Push and open the SDK PR**

```bash
git push -u origin feat/halt-persist-flag
gh pr create --title "feat(hooks): add optional halt.persist to skip turn persistence" --body-file /tmp/sdk-pr.md
```

The PR body states: what the flag does, that it defaults to `true` (backwards compatible), that the engine consumes it in a follow-up PR, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 9: STOP — human gate**

The SDK PR must be merged and tagged `v1.5.0` before Task 2. Ask the user to merge + tag; do not proceed on an untagged SDK.

---

### Task 2: Engine — bump the SDK pin

**Files:**
- Modify: `packages/engine/package.json:47` (the `@polyant-ai/plugin-sdk` dependency)
- Modify: `package-lock.json` (monorepo root)

**Interfaces:**
- Consumes: SDK tag `v1.5.0` from Task 1.
- Produces: `HookResult["halt"].persist` visible to the engine's type-checker.

- [ ] **Step 1: Change the pin**

In `packages/engine/package.json`, `git+https://github.com/polyant-ai/polyant-sdk.git#v1.4.0` → `...#v1.5.0`.

- [ ] **Step 2: Reinstall from the monorepo root**

Run: `npm install`
Expected: `package-lock.json` updated; every `resolved` ref for `@polyant-ai/plugin-sdk` points at the `v1.5.0` ref (grep it — a stale `v1.4.0` resolved ref is a known trap in this repo).

Run: `grep -n "polyant-sdk" package-lock.json`
Expected: no remaining `#v1.4.0`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS (nothing uses the new field yet).

- [ ] **Step 4: Commit**

```bash
git add packages/engine/package.json package-lock.json
git commit -F /tmp/msg.txt
```

Message: `chore(engine): bump plugin-sdk to v1.5.0 (halt.persist)` + DCO + Co-Authored-By trailers.

---

### Task 3: Engine — honour `halt.persist` on the conversational path

**Files:**
- Modify: `packages/engine/src/hooks/hook-types.ts` (`HookHaltSignal`)
- Modify: `packages/engine/src/hooks/actions/function-action.ts` (halt capture)
- Modify: `packages/engine/src/pipeline.ts` (`PipelinePreResult.shortCircuit`, `runPipelinePre` return, `PipelinePostOptions`, `runPipelinePost` gating)
- Modify: `packages/engine/src/index.ts` (both halt call sites: `runBufferedTurn` ~line 231, `handleMessageStream` ~line 381)
- Test: `packages/engine/src/hooks/hook-halt.test.ts`

**Interfaces:**
- Consumes: `HookResult["halt"].persist` (Task 2).
- Produces:
  - `HookHaltSignal = { message: string; persist?: boolean }`
  - `PipelinePreResult.shortCircuit?: { text: string; persist: boolean }` (always resolved to a boolean)
  - `PipelinePostOptions.persist?: boolean` (absent ⇒ `true`)

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/src/hooks/hook-halt.test.ts`. Follow the mocking style already used in that file — reuse its existing `vi.mock` block and helpers rather than inventing new ones; the assertions below are the new content:

```ts
describe("halt persist:false", () => {
  it("propagates persist from the hook return to shortCircuit", async () => {
    registerTestHook({ halt: { message: "RESET → #12345", persist: false } });

    const pre = await runPipelinePre(baseMessage());

    expect(pre.shortCircuit).toEqual({ text: "RESET → #12345", persist: false });
  });

  it("defaults persist to true when the hook omits it", async () => {
    registerTestHook({ halt: { message: "closed" } });

    const pre = await runPipelinePre(baseMessage());

    expect(pre.shortCircuit).toEqual({ text: "closed", persist: true });
  });

  it("skips trace, state flush and afterResponse when persist is false", async () => {
    const ctx = await preparePipeline(baseMessage());
    ctx.stateBuffer = { flush: vi.fn() } as never;

    const { finalText } = await runPipelinePost({
      ...basePostOptions(ctx),
      resultText: "RESET → #12345",
      persist: false,
    });

    expect(finalText).toBe("RESET → #12345");
    expect(traceStore.record).not.toHaveBeenCalled();
    expect(ctx.stateBuffer.flush).not.toHaveBeenCalled();
    expect(afterResponseSpy).not.toHaveBeenCalled();
  });

  it("still persists when persist is absent", async () => {
    const ctx = await preparePipeline(baseMessage());

    await runPipelinePost({ ...basePostOptions(ctx), resultText: "hello" });

    expect(traceStore.record).toHaveBeenCalledOnce();
    expect(afterResponseSpy).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @polyant/engine -- src/hooks/hook-halt.test.ts`
Expected: FAIL — `persist` is not a known property of `shortCircuit`/`PipelinePostOptions`, and the `persist: false` case still records a trace.

- [ ] **Step 3: Widen the halt signal**

`packages/engine/src/hooks/hook-types.ts` — replace the `HookHaltSignal` interface:

```ts
/** Payload of a halt: the message delivered to the user in place of the LLM turn. */
export interface HookHaltSignal {
  message: string;
  /** When false, the halted turn is not persisted (no messages/trace/state/summary). */
  persist?: boolean;
}
```

- [ ] **Step 4: Capture the flag in the function executor**

`packages/engine/src/hooks/actions/function-action.ts` — replace the halt capture line:

```ts
    if (result.halt?.message?.trim()) {
      capture({ halt: { message: result.halt.message, persist: result.halt.persist } });
    }
```

- [ ] **Step 5: Resolve the flag in `runPipelinePre`**

`packages/engine/src/pipeline.ts` — in `PipelinePreResult`, replace the `shortCircuit` field:

```ts
  /** Set when a pre-LLM hook requested a halt: the LLM call is skipped and this text is the reply.
   *  `persist: false` makes the halted turn ephemeral (see runPipelinePost). */
  shortCircuit?: { text: string; persist: boolean };
```

and in the `return` of `runPipelinePre`:

```ts
    shortCircuit: halt ? { text: halt.message, persist: halt.persist !== false } : undefined,
```

- [ ] **Step 6: Gate the persistence side effects in `runPipelinePost`**

`packages/engine/src/pipeline.ts` — add to `PipelinePostOptions`, next to `abortSignal`:

```ts
  /** When false, skip every persistence side effect for this turn (hook halt with
   *  persist:false): no trace, no state flush, no afterResponse, no contextPrompt clear.
   *  Hooks and hook_executions telemetry still run — the execution happened. */
  persist?: boolean;
```

In `runPipelinePost`, right after `const { ctx } = opts;`:

```ts
  const persist = opts.persist !== false;
```

Then wrap, without reordering anything:
- the `if (!isAutoTask(opts.messageText)) { traceStore.record({...}) }` block → `if (persist && !isAutoTask(opts.messageText)) { ... }`
- the first `if (ctx.stateBuffer) { ... flush ... }` → `if (persist && ctx.stateBuffer) { ... }`
- the `afterResponse({...})` call → wrap in `if (persist) { ... }`
- the `if (ctx.contextPrompt) { clearContextPrompt ... }` → `if (persist && ctx.contextPrompt) { ... }`
- the second flush inside the `response_sent` block → `if (persist && ctx.stateBuffer) { ... }`

`pipelineLog.response`, the `response_generated`/`response_sent` hook runs and the `return { finalText, hookExecutions }` stay unconditional.

- [ ] **Step 7: Thread the flag from both halt call sites**

`packages/engine/src/index.ts` — in `runBufferedTurn`'s `if (pre.shortCircuit)` block, add to the `runPipelinePost({...})` argument object:

```ts
        persist: pre.shortCircuit.persist,
```

and identically in the `if (pre.shortCircuit)` block of `handleMessageStream`.

- [ ] **Step 8: Run the tests**

Run: `npm test -w @polyant/engine -- src/hooks/hook-halt.test.ts`
Expected: PASS, including the two pre-existing halt tests (they exercise the default `persist: true` path).

- [ ] **Step 9: Run the neighbouring suites**

Run: `npm test -w @polyant/engine -- src/hooks src/pipeline`
Expected: PASS. Any failure here is a regression from Step 6 — check that a gated block was not accidentally moved.

- [ ] **Step 10: Commit**

```bash
git add packages/engine/src/hooks packages/engine/src/pipeline.ts packages/engine/src/index.ts
git commit -F /tmp/msg.txt
```

Message: `feat(hooks): honour halt.persist to keep a halted turn ephemeral` + a body explaining what is skipped and what still runs + DCO + Co-Authored-By trailers.

---

### Task 4: Engine — the `conversation-reset` hook function

**Files:**
- Create: `packages/engine/src/hooks/functions/conversation-reset.hook.ts`
- Test: `packages/engine/src/hooks/functions/conversation-reset.hook.test.ts`

**Interfaces:**
- Consumes: `defineHook` from `@polyant-ai/plugin-sdk`, `conversationStore.renameConversation(oldId, newId, title?)` and `conversationStore.getConversation(id, orgId?)` from `../../conversations/store.js`, `HookContext.payload.{message.text, conversation.id}`.
- Produces: a hook function registered as `conversation-reset` (discovered by `loadAllHooks()` from `getCoreHooksDir()`), selectable in the Hooks tab.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/src/hooks/functions/conversation-reset.hook.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../conversations/store.js", () => ({
  conversationStore: {
    renameConversation: vi.fn(async () => true),
    getConversation: vi.fn(async () => null),
  },
}));

import { conversationStore } from "../../conversations/store.js";
import resetHook from "./conversation-reset.hook.js";
import type { HookContext } from "@polyant-ai/plugin-sdk";

const CONV_ID = "acme:whatsapp:+393331112223";

function ctx(text: string): HookContext {
  return {
    event: "message_received",
    payload: {
      instance: { slug: "acme" },
      conversation: { id: CONV_ID },
      channel: { type: "whatsapp", id: "+393331112223" },
      user: { name: "tester" },
      message: { text },
    },
  } as unknown as HookContext;
}

describe("conversation-reset hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(conversationStore.getConversation).mockResolvedValue(null);
    vi.mocked(conversationStore.renameConversation).mockResolvedValue(true);
  });

  it("does nothing on a normal message", async () => {
    const result = await resetHook.handler(ctx("ciao, come stai?"));

    expect(result).toBeUndefined();
    expect(conversationStore.renameConversation).not.toHaveBeenCalled();
  });

  it("does nothing when RESET is embedded in a longer message", async () => {
    const result = await resetHook.handler(ctx("RESET per favore"));

    expect(result).toBeUndefined();
    expect(conversationStore.renameConversation).not.toHaveBeenCalled();
  });

  it("archives the conversation on an exact, case-insensitive match", async () => {
    const result = await resetHook.handler(ctx("  reset \n"));

    expect(conversationStore.renameConversation).toHaveBeenCalledOnce();
    const [oldId, newId] = vi.mocked(conversationStore.renameConversation).mock.calls[0];
    expect(oldId).toBe(CONV_ID);
    expect(newId).toMatch(new RegExp(`^${CONV_ID.replace(/\+/g, "\\+")}#\\d{5}$`));
    expect(result).toEqual({ halt: { message: expect.stringContaining("#"), persist: false } });
  });

  it("picks a different id when the first candidate is taken", async () => {
    vi.mocked(conversationStore.getConversation)
      .mockResolvedValueOnce({ conversationId: "taken" } as never)
      .mockResolvedValueOnce(null);

    await resetHook.handler(ctx("RESET"));

    expect(conversationStore.getConversation).toHaveBeenCalledTimes(2);
    const [, newId] = vi.mocked(conversationStore.renameConversation).mock.calls[0];
    expect(newId).toMatch(new RegExp(`^${CONV_ID.replace(/\+/g, "\\+")}#\\d{5}$`));
  });

  it("falls back to a timestamp suffix when both candidates are taken", async () => {
    vi.mocked(conversationStore.getConversation).mockResolvedValue({ conversationId: "taken" } as never);

    await resetHook.handler(ctx("RESET"));

    const [, newId] = vi.mocked(conversationStore.renameConversation).mock.calls[0];
    expect(newId).toMatch(new RegExp(`^${CONV_ID.replace(/\+/g, "\\+")}#\\d{10,}$`));
  });

  it("reports failure instead of claiming success when the rename throws", async () => {
    vi.mocked(conversationStore.renameConversation).mockRejectedValue(new Error("db down"));

    const result = await resetHook.handler(ctx("RESET"));

    expect(result).toEqual({ halt: { message: "RESET failed — the conversation was not archived.", persist: false } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @polyant/engine -- src/hooks/functions/conversation-reset.hook.test.ts`
Expected: FAIL — `Cannot find module './conversation-reset.hook.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/engine/src/hooks/functions/conversation-reset.hook.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineHook } from "@polyant-ai/plugin-sdk";
// First-party hook: importing the engine's store is fine in-tree, but it makes this
// function non-portable as an external plugin. If reset is ever needed from a plugin,
// expose it as a method on `ctx.conversation` in the SDK instead.
import { conversationStore } from "../../conversations/store.js";

/** Whole-message keyword, matched case-insensitively. Deliberately not configurable. */
const KEYWORD = "RESET";

/** Random 5-digit archive suffix (10000–99999 — always 5 chars). */
function randomSuffix(): string {
  return String(10000 + Math.floor(Math.random() * 90000));
}

/**
 * Pick an unused archive id: two random candidates, then a timestamp fallback so
 * the rename can never fail on a collision.
 */
async function pickArchiveId(conversationId: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = `${conversationId}#${randomSuffix()}`;
    const existing = await conversationStore.getConversation(candidate);
    if (!existing) return candidate;
  }
  return `${conversationId}#${Date.now()}`;
}

/**
 * Archive the current conversation on a `RESET` message so a tester can start from a
 * clean slate without leaving the chat — the conversation id is derived from the
 * channel id (the phone number on WhatsApp), so everyone sharing a number otherwise
 * shares one ever-growing conversation.
 *
 * The old conversation is renamed (history stays browsable in the panel under the
 * suffixed id), never deleted; the next inbound message re-creates the canonical id
 * empty. `persist: false` keeps the RESET turn itself out of both conversations.
 */
export default defineHook({
  name: "conversation-reset",
  description:
    "On a message that is exactly \"RESET\", archive the current conversation (rename with a random 5-digit suffix) so the next message starts a fresh one. For test instances.",
  handler: async (ctx) => {
    if (ctx.payload.message.text.trim().toUpperCase() !== KEYWORD) return;

    const conversationId = ctx.payload.conversation.id;
    try {
      const archiveId = await pickArchiveId(conversationId);
      await conversationStore.renameConversation(conversationId, archiveId);
      const suffix = archiveId.slice(conversationId.length);
      return { halt: { message: `RESET → ${suffix}`, persist: false } };
    } catch (err) {
      console.error(`[conversation-reset] rename failed for ${conversationId}:`, err);
      return { halt: { message: "RESET failed — the conversation was not archived.", persist: false } };
    }
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @polyant/engine -- src/hooks/functions/conversation-reset.hook.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify the loader picks it up**

Run: `npm test -w @polyant/engine -- src/hooks/hook-loader.test.ts`
Expected: PASS — the loader test mocks `getCoreHooksDir` to a fixture dir, so the new file must not change its counts. If it does, the mock is leaking and the test needs the real dir excluded.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/hooks/functions
git commit -F /tmp/msg.txt
```

Message: `feat(hooks): add conversation-reset hook function (RESET keyword)` + body + DCO + Co-Authored-By trailers.

---

### Task 5: Documentation and final verification

**Files:**
- Modify: `CLAUDE.md` (the hooks bullet under "Key Conventions")
- Modify: `packages/engine/docs/plugins.md` if it documents `HookResult` members — check with `grep -n "injectContext" packages/engine/docs/plugins.md docs/plugins.md 2>/dev/null` and update the same list where the other control returns are described.

- [ ] **Step 1: Document the control return and the hook function**

Extend the existing `HookResult` enumeration in `CLAUDE.md` (the sentence listing `halt`/`replaceResponse`/`injectContext`/`regenerate`) with:

> A `halt` may carry `persist: false` — the canned reply is delivered but the turn is NOT persisted (no user/assistant rows, no `pipeline_traces`, no state flush, no summary/memory work, no contextPrompt clear); the hook execution is still recorded in `hook_executions`. Honored on the conversational path only (buffered + streaming); the supervise-direct Room/Webhook engines ignore it. The first first-party hook function, `conversation-reset` (`hooks/functions/conversation-reset.hook.ts`), uses it: on a message that is exactly `RESET` it renames the current conversation to `<id>#<5 digits>` via `renameConversation` (history stays browsable, `conversation_state` moves with it) so the next message starts a clean conversation — enable it per instance from the Hooks tab on test agents. Design: `docs/superpowers/specs/2026-07-29-conversation-reset-keyword-design.md`.

- [ ] **Step 2: Full verification**

Run each and confirm the output before claiming success:

```bash
npm run typecheck -w @polyant/engine
npm run lint -w @polyant/engine
npm test -w @polyant/engine
```

Expected: typecheck and lint clean. For the test suite, compare failures against a baseline on `develop` (`git stash && npm test -w @polyant/engine`): this checkout has pre-existing collection failures from missing local deps, which are NOT regressions. Report the delta, not the absolute count.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -F /tmp/msg.txt
```

Message: `docs(hooks): document halt.persist + conversation-reset hook` + DCO + Co-Authored-By trailers.

- [ ] **Step 4: Push and open the engine PR against `develop`**

```bash
git push -u origin feature/secret-word-chat-rename-174e66
gh pr create --base develop --title "feat(hooks): RESET keyword archives the conversation and starts a clean one" --body-file /tmp/pr.md
```

PR body (English): the problem (one conversation per phone number blocks repeated testing), the behaviour (`RESET` → rename with 5-digit suffix → next message starts empty → RESET turn not persisted), the three moving parts (SDK `halt.persist`, `runPipelinePost` gating, `conversation-reset` hook function), how to test it (enable the hook on a test instance from the Hooks tab, send `RESET` from WhatsApp or the playground, confirm the archived conversation in the list and an empty new one), the noted caveats (fragment bursts, panel noise, Room/Webhook ignore `persist`), a link to the spec, and the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` footer.

---

## Self-Review

- **Spec coverage**: SDK flag → Task 1; engine gating → Task 3; hook function with exact match, hardcoded keyword, collision handling, rename-failure path, import-boundary comment → Task 4; enablement (no code needed) + caveats → documented in Task 5; tests → Tasks 1/3/4.
- **Type consistency**: `HookHaltSignal.persist?: boolean` (Task 3 Step 3) matches the SDK's `halt.persist?: boolean` (Task 1) and the capture in Step 4; `shortCircuit.persist` is a resolved non-optional `boolean` and both call sites in Step 7 pass it into `PipelinePostOptions.persist?: boolean`; `renameConversation(oldId, newId, title?)` and `getConversation(id, orgId?)` are used with the signatures in `conversations/store.ts`.
- **Known gap, deliberate**: Room and Webhook engines never call `runPipelinePost`, so `persist` has no effect there. Documented in Task 5 and in the SDK doc comment rather than implemented — their conversations are already per-cycle ephemeral.
