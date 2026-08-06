# WhatsApp interactive templates in the inbound chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent reply to a live inbound WhatsApp user (open 24h window) with a pre-created interactive Content template, and have that template — not the LLM free-form text — be the one message delivered and persisted.

**Architecture:** Three targeted framework changes, no new tool and no dynamic Content creation. (1) `send_whatsapp_template` resolves its outbound target from the trusted channel identity (`ctx.state.channel`) when there is no webhook trigger context. (2) A pure `resolveDeliveredReply` helper decides what to persist vs deliver when a tool already handled the reply; `runBufferedTurn` uses it to honor `replyHandled` on the inbound path. (3) `runBufferedTurn` equips channel-category harness tools so the whatsapp template tool is reachable on the inbound path.

**Tech Stack:** TypeScript (ESM), NestJS engine, Vitest, Twilio Content API (WhatsApp), Drizzle (unaffected here).

**Spec:** `docs/superpowers/specs/2026-07-24-whatsapp-interactive-inbound-design.md`

## Global Constraints

- **ESM only:** relative imports MUST end in `.js`; named exports only; filenames kebab-case.
- **Framework-first:** no instance-specific logic; the agent supplies the `contentSid` (from the instance prompt) — code stays domain-agnostic.
- **Out-of-scope edge case (do NOT handle):** a `response_generated` hook `replaceResponse` combined with a tool that already delivered a template is knowingly unhandled (see spec §5 Fix 3). Do not add logic for it.
- **Test runner:** Vitest. Single file: `npm test -w @polyant/engine -- <path-substring>`. By name: append `-t "<name>"`. Typecheck: `npm run typecheck -w @polyant/engine`. Lint: `npm run lint -w @polyant/engine`.
- **Workspace:** worktree `.claude/worktrees/feat+whatsapp-interactive-inbound`, branch `feat/whatsapp-interactive-inbound`. PR base is `develop`; PR title/body in English.
- **Commits:** conventional-commits, English. Every commit MUST carry both trailers:
  `Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>` and
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
  Use `git commit -F <file>` (multi-line `-m` corrupts newlines in this shell).

---

## File Structure

- `packages/engine/src/agents/tools/send-whatsapp-template.tool.ts` — **modify**: resolve outbound target from trigger context OR `ctx.state.channel`; update description. (Task 1)
- `packages/engine/src/agents/tools/send-whatsapp-template.tool.test.ts` — **modify**: update the "missing trigger context" test, add fallback-path tests. (Task 1)
- `packages/engine/src/reply-delivery.ts` — **create**: pure `resolveDeliveredReply` helper. (Task 2)
- `packages/engine/src/reply-delivery.test.ts` — **create**: unit tests for the helper. (Task 2)
- `packages/engine/src/index.ts` — **modify** `runBufferedTurn`: use the helper to honor `replyHandled` (Task 2); add `includeHarness` to `superviseArgs` (Task 3).

---

## Task 1: Ungate `send_whatsapp_template` for the inbound chat (Fix 2)

**Files:**
- Modify: `packages/engine/src/agents/tools/send-whatsapp-template.tool.ts` (execute body + description)
- Test: `packages/engine/src/agents/tools/send-whatsapp-template.tool.test.ts`

**Interfaces:**
- Consumes: `ctx.state?.channel` → `{ type: string; id: string } | undefined` (from `ConversationStateApi`, already on `ToolContext`); `ctx.instanceId` (InstanceSlug); `channelManager.sendOutboundTemplate(instanceSlug, channelType, channelId, contentSid, variables)`; `channelManager.getOutboundTemplateBody(instanceSlug, channelType, contentSid, variables)`.
- Produces: unchanged tool result shape `{ success, replyHandled: true, replyText, contentSid, target, messageSid } | { error }`.

- [ ] **Step 1: Update the outdated test for the missing-context case**

The current test asserts an error when the trigger context is missing. Under Fix 2 that is only an error when there is ALSO no channel identity. Replace the test body and add the `createMockState` import.

At the top of `send-whatsapp-template.tool.test.ts`, extend the test-utils import:

```ts
import { createMockAudit, createMockState } from "../../test-utils.js";
```

Change `buildExecute` to accept an optional state:

```ts
function buildExecute(
  conversationId: string | undefined = "conv-1",
  state?: import("../../conversations/state.buffer.js").ConversationStateApi,
) {
  const ctx = {
    instanceId: "inst-1",
    secrets: {},
    audit: createMockAudit(),
    conversationId,
    state,
  } as any;
  return (input: any) => def.execute(input, ctx);
}
```

Replace the existing `it("returns error when trigger context is missing", ...)` with:

```ts
it("returns error when neither trigger context nor channel identity is available", async () => {
  mockGetTriggerContext.mockReturnValueOnce(null);
  const execute = buildExecute(); // no state seeded
  const res = (await execute({ contentSid: "HXabc123", variables: [] })) as { error: string };
  expect(res.error).toMatch(/No outbound target/i);
  expect(mockSendOutboundTemplate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add the failing fallback tests (inbound channel identity)**

Add these two tests inside the `describe` block:

```ts
it("falls back to ctx.state.channel when there is no trigger context (whatsapp)", async () => {
  mockGetTriggerContext.mockReturnValueOnce(null);
  mockSendOutboundTemplate.mockResolvedValueOnce("SM_INBOUND_1");
  const state = createMockState({ _channel: { type: "whatsapp", id: "+393334678966" } });

  const execute = buildExecute("inst-1:whatsapp:+393334678966", state);
  const res = (await execute({ contentSid: "HXabc123", variables: ["Mario"] })) as {
    replyHandled: boolean;
    target: string;
  };

  expect(mockSendOutboundTemplate).toHaveBeenCalledWith(
    "inst-1",
    "whatsapp",
    "+393334678966",
    "HXabc123",
    { "1": "Mario" },
  );
  expect(res.replyHandled).toBe(true);
  expect(res.target).toBe("+393334678966");
});

it("errors when the fallback channel identity is not whatsapp", async () => {
  mockGetTriggerContext.mockReturnValueOnce(null);
  const state = createMockState({ _channel: { type: "telegram", id: "12345" } });

  const execute = buildExecute("inst-1:telegram:12345", state);
  const res = (await execute({ contentSid: "HXabc123", variables: [] })) as { error: string };

  expect(res.error).toMatch(/not whatsapp/i);
  expect(mockSendOutboundTemplate).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @polyant/engine -- send-whatsapp-template.tool`
Expected: the three new/updated tests FAIL (current tool still returns "No active trigger context" and never reads `ctx.state`).

- [ ] **Step 4: Implement target resolution in the tool**

In `send-whatsapp-template.tool.ts`, replace the `execute` body from the `triggerCtx` lookup through the two guard returns with the resolution block below, and thread the resolved `instanceSlug`/`channelType`/`target` through the two `channelManager` calls. Full new `execute`:

```ts
  execute: async ({ contentSid, variables }: { contentSid: string; variables: string[] }, ctx) => {
    // Positional array → 1-based index map for Twilio contentVariables
    const variablesMap: Record<string, string> = Object.fromEntries(
      variables.map((value, index) => [String(index + 1), value]),
    );

    // Resolve the outbound target. Prefer an active webhook trigger context
    // (proactive path); otherwise fall back to the live channel identity of the
    // current conversation (inbound chat). ctx.state.channel is server-seeded and
    // trusted — never an LLM-supplied argument.
    const triggerCtx = getTriggerContext(ctx.conversationId ?? "");
    let instanceSlug: string;
    let channelType: string;
    let target: string;

    if (triggerCtx) {
      instanceSlug = triggerCtx.instanceSlug;
      channelType = triggerCtx.outboundChannel;
      target = triggerCtx.outboundTarget;
    } else {
      const channel = ctx.state?.channel;
      if (!channel) {
        return {
          error:
            "No outbound target: neither a webhook trigger context nor a live channel identity is available.",
        };
      }
      instanceSlug = ctx.instanceId;
      channelType = channel.type;
      target = channel.id;
    }

    if (channelType !== "whatsapp") {
      return {
        error: `Outbound channel is "${channelType}", not whatsapp. Template send not supported.`,
      };
    }

    try {
      const messageSid = await channelManager.sendOutboundTemplate(
        instanceSlug,
        channelType,
        target,
        contentSid,
        variablesMap,
      );

      let replyText: string;
      try {
        replyText = await channelManager.getOutboundTemplateBody(
          instanceSlug,
          channelType,
          contentSid,
          variablesMap,
        );
      } catch (err) {
        console.warn(
          `[send_whatsapp_template] content api fetch failed for ${contentSid}: ${err instanceof Error ? err.message : String(err)} — falling back to stub catalog / summary`,
        );
        replyText =
          renderStubTemplate(contentSid, variablesMap) ??
          `[WhatsApp template sent: ${contentSid} · variables: ${JSON.stringify(variables)}]`;
      }

      return {
        success: true,
        replyHandled: true,
        replyText,
        contentSid,
        target,
        messageSid,
      };
    } catch (err) {
      return {
        error: `Failed to send WhatsApp template: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
```

- [ ] **Step 5: Update the tool description**

Replace the last description line so the model knows it works in the inbound chat too:

```ts
    "Available in a webhook-triggered conversation OR a live WhatsApp chat within the open 24h customer-service window.",
```

(Delete the old `"Only available inside a webhook-triggered conversation on a WhatsApp outbound channel."` line.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @polyant/engine -- send-whatsapp-template.tool`
Expected: PASS (all tests, including the existing trigger-context tests which still take the `triggerCtx` branch).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
printf '%s\n' \
"feat(whatsapp): allow send_whatsapp_template in a live inbound chat" \
"" \
"Resolve the outbound target from ctx.state.channel when there is no" \
"webhook trigger context, so the tool can reply with an interactive" \
"Content template inside the open 24h window. Guarded to whatsapp only." \
"" \
"Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>" \
"Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" > /tmp/cm-t1.txt
git add packages/engine/src/agents/tools/send-whatsapp-template.tool.ts packages/engine/src/agents/tools/send-whatsapp-template.tool.test.ts
git commit -F /tmp/cm-t1.txt
```

---

## Task 2: `resolveDeliveredReply` helper + honor `replyHandled` on the inbound path (Fix 3)

**Files:**
- Create: `packages/engine/src/reply-delivery.ts`
- Test: `packages/engine/src/reply-delivery.test.ts`
- Modify: `packages/engine/src/index.ts` (`runBufferedTurn`, around the `runPipelinePost` call at ~L321 and the return at ~L352)

**Interfaces:**
- Produces: `resolveDeliveredReply(input: { replyHandled?: boolean; replyText?: string; llmText: string }): { persistText: string; toolDelivered: boolean }`.
- Consumes (in index.ts): the supervise result `result.replyHandled?: boolean` / `result.replyText?: string`, and `replayText` (the LLM final text) — both already in scope in `runBufferedTurn`.

- [ ] **Step 1: Write the failing helper test**

Create `packages/engine/src/reply-delivery.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { resolveDeliveredReply } from "./reply-delivery.js";

describe("resolveDeliveredReply", () => {
  it("persists the tool replyText and suppresses delivery when a tool handled the reply", () => {
    const r = resolveDeliveredReply({ replyHandled: true, replyText: "List body\n[Button: A]", llmText: "ignored" });
    expect(r.persistText).toBe("List body\n[Button: A]");
    expect(r.toolDelivered).toBe(true);
  });

  it("falls back to the LLM text when a tool handled the reply but supplied no replyText", () => {
    const r = resolveDeliveredReply({ replyHandled: true, replyText: "", llmText: "llm text" });
    expect(r.persistText).toBe("llm text");
    expect(r.toolDelivered).toBe(true);
  });

  it("uses the LLM text for both persistence and delivery when no tool handled the reply", () => {
    const r = resolveDeliveredReply({ replyHandled: false, llmText: "llm text" });
    expect(r.persistText).toBe("llm text");
    expect(r.toolDelivered).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @polyant/engine -- reply-delivery`
Expected: FAIL — `Cannot find module './reply-delivery.js'`.

- [ ] **Step 3: Implement the helper**

Create `packages/engine/src/reply-delivery.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decide, for a single inbound turn, what to persist as the assistant message
 * and whether the channel adapter still needs to deliver anything.
 *
 * A tool may deliver its own reply during execution (e.g. `send_whatsapp_template`
 * sends an interactive Content template and returns `replyHandled: true`). In
 * that case the adapter must NOT send a second message, and the persisted turn
 * should be the tool's rendered reply — not the LLM free-form text. Mirrors the
 * precedence the webhook engine already uses.
 */
export interface DeliveredReply {
  /** Text to persist as the assistant turn (conversation history). */
  persistText: string;
  /** True when a tool already delivered the reply — the adapter sends nothing more. */
  toolDelivered: boolean;
}

export function resolveDeliveredReply(input: {
  replyHandled?: boolean;
  replyText?: string;
  llmText: string;
}): DeliveredReply {
  const toolDelivered = input.replyHandled === true;
  const persistText = toolDelivered && input.replyText ? input.replyText : input.llmText;
  return { persistText, toolDelivered };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @polyant/engine -- reply-delivery`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the helper into `runBufferedTurn`**

In `packages/engine/src/index.ts`, add the import near the other pipeline imports:

```ts
import { resolveDeliveredReply } from "./reply-delivery.js";
```

In `runBufferedTurn`, immediately after `const { result, finalText: replayText, outcome } = replay;` (~L308) and its cap-warning block, compute the delivery decision:

```ts
    const { persistText, toolDelivered } = resolveDeliveredReply({
      replyHandled: result.replyHandled,
      replyText: result.replyText,
      llmText: replayText,
    });
```

Change the `runPipelinePost({ ... })` call to persist `persistText` instead of `replayText`:

```ts
      resultText: persistText,
```

Change the final `return` of `runBufferedTurn` so a tool-delivered turn sends nothing more via the adapter:

```ts
    return {
      text: toolDelivered ? "" : finalText,
      toolCalls: result.toolCallTraces?.map((t) => ({ name: t.name, durationMs: t.duration_ms })),
      usage: result.usage ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens } : undefined,
    };
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: no errors.

- [ ] **Step 7: Run the helper tests again + the tool tests (nothing regressed)**

Run: `npm test -w @polyant/engine -- reply-delivery send-whatsapp-template.tool`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
printf '%s\n' \
"feat(pipeline): honor tool-delivered replies on the inbound path" \
"" \
"Add resolveDeliveredReply and use it in runBufferedTurn: when a tool sets" \
"replyHandled, persist its replyText and return an empty text so the channel" \
"adapter does not send a second message. Mirrors the webhook engine." \
"" \
"Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>" \
"Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" > /tmp/cm-t2.txt
git add packages/engine/src/reply-delivery.ts packages/engine/src/reply-delivery.test.ts packages/engine/src/index.ts
git commit -F /tmp/cm-t2.txt
```

---

## Task 3: Equip channel-category harness tools on the inbound path (Fix 1)

**Files:**
- Modify: `packages/engine/src/index.ts` (`runBufferedTurn`, the `superviseArgs` object ~L252-283)

**Interfaces:**
- Consumes: `msg.channelType` (already in scope); `SuperviseInput.includeHarness?: Set<string>` (already supported by `supervise`).
- Produces: `send_whatsapp_template` (category `"whatsapp"`) becomes reachable when `msg.channelType === "whatsapp"`. No new exported symbols.

- [ ] **Step 1: Add `includeHarness` to `superviseArgs`**

In `runBufferedTurn`, inside the `superviseArgs` object literal, add (place it near `stateBuffer` / the other config fields):

```ts
      // Equip channel-category harness tools on the inbound path: a tool whose
      // category equals the inbound channel type becomes available (today only
      // send_whatsapp_template on whatsapp). No-op for channels without a
      // matching harness tool. Deliberately generic (no category allow-list) —
      // see spec §5 Fix 1.
      includeHarness: new Set([msg.channelType]),
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: no errors (`includeHarness` is an existing `SuperviseInput` field).

- [ ] **Step 3: Lint**

Run: `npm run lint -w @polyant/engine`
Expected: no errors.

- [ ] **Step 4: Full unit suite (no regressions across the three fixes)**

Run: `npm run test:unit -w @polyant/engine`
Expected: PASS. Classify any failure per `.claude/rules/testing.md` (REGRESSION vs TEST OUTDATED) before touching it.

- [ ] **Step 5: Manual integration smoke (documented, not automated)**

`runBufferedTurn` is a closure inside `index.ts` and is not unit-testable in isolation; verify end-to-end against a real instance:
1. Configure a WhatsApp channel on a test instance; create a list-picker Content template in Twilio (`HX...`).
2. In the instance prompt, instruct the agent to call `send_whatsapp_template` with that `HX...` when appropriate.
3. From your phone, open the 24h window (message the bot), then send a message that triggers the list.
4. Confirm: exactly ONE message arrives (the list, no duplicate text bubble), and the conversation detail in the admin panel shows the rendered template body (with `[Button: …]` lines) as the assistant turn.

Record the outcome in the PR description.

- [ ] **Step 6: Commit**

```bash
printf '%s\n' \
"feat(pipeline): equip channel-category harness tools on the inbound path" \
"" \
"runBufferedTurn now passes includeHarness = Set([msg.channelType]) so a" \
"harness tool whose category matches the inbound channel is available." \
"Today this equips send_whatsapp_template on whatsapp inbound chats." \
"" \
"Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>" \
"Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" > /tmp/cm-t3.txt
git add packages/engine/src/index.ts
git commit -F /tmp/cm-t3.txt
```

---

## Done criteria

- `send_whatsapp_template` is reachable and functional in a live inbound WhatsApp conversation within the open 24h window.
- Calling it delivers exactly one interactive message; the rendered template body (with options) is persisted as the assistant turn; no duplicate LLM text bubble.
- `npm run typecheck`, `npm run lint`, and `npm run test:unit` for `@polyant/engine` all pass.
- Manual WhatsApp smoke recorded in the PR (English), targeting `develop`.
