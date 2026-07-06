# Hook Functions — Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Follow the `frontend-design-system` skill (tokens, i18n in BOTH en.json + it.json, shadcn `Select`, no raw strings).

**Goal:** Migrate the hooks admin UI from the tool-as-hook model to the hook-function model: a function picker (no args-template), a streaming warning for `mutatesResponse` hooks, hook-execution pills relabeled tool→function, and a provenance badge on hook-authored assistant messages.

**Architecture:** Web (packages/web, Next.js/React 19/Tailwind 4/shadcn). Consumes the engine's new `GET /api/hook-functions` catalog + the `metadata.source="hook"` provenance already persisted on assistant rows (both on `feat/hook-functions`). Data via the centralized `lib/api.ts` client.

**Branch:** `feat/hook-functions` (same branch as the engine work — extends PR #162 to the full feature).

**Spec:** `docs/superpowers/specs/2026-07-03-hook-functions-design.md` §7.

---

## Web anchors (from exploration)

- Config tab: `src/app/(admin)/instances/[slug]/hooks-tab.tsx` — `HooksTab({slug})`; form fields event/toolName(select from `api.tools.catalog()`)/argsText(JSON)/timeoutMs/position; submits `{ event, actionConfig: {toolName, args}, ... }` via `api.hooks.create/update`.
- Execution pill: `src/components/messages/hook-execution-pill.tsx` — `HookExecutionView { event, toolName, success, error?, durationMs, args?, result? }`. Mounted in conversation-detail (`conversations/[conversationId]/page.tsx`) + playground (`playground/_components/message-bubble.tsx`).
- Assistant message: `ConversationMessage` (`lib/api-types.ts`) has `metadata: Record<string,unknown>|null`. Rendered in conversation-detail (~line 484) + playground `message-bubble.tsx` (~line 51). Conversation-detail already reads `metadata?.originalKind`.
- API client: `src/lib/api.ts` — singleton `api`, `request<T>()`. `api.hooks.{list,create,update}`, `api.tools.catalog()`, `api.conversations.{messages,hookExecutions}`.
- i18n: `src/lib/i18n/locales/{en,it}.json` — `hooks.*` namespace (~line 582/581).

---

## Task W1: API client — hook-functions catalog

**Files:** Modify `src/lib/api.ts` (+ its inline types).

- [ ] **Step 1:** Add a catalog type + method. Near the hooks types/methods in `api.ts`:
  ```ts
  export interface HookFunctionInfo {
    name: string;
    description: string;
    requiredSecrets: Array<{ key: string; type: "text" | "select"; label?: string; choices?: string[]; optional?: boolean; sensitive?: boolean }>;
    mutatesResponse: boolean;
  }
  ```
  In the `hooks` group of the `api` object, add:
  ```ts
  functions: () => request<{ hookFunctions: HookFunctionInfo[] }>(`/api/hook-functions`),
  ```
  (Match the exact response envelope the engine controller returns — the engine returns `{ hookFunctions: [...] }` OR a bare array; verify against `packages/engine/src/server/hooks/hook-functions.controller.ts` and match it. Adjust the generic accordingly.)
- [ ] **Step 2:** Verify `api.conversations.messages(...)` already surfaces `metadata` on `ConversationMessage` (it does per api-types.ts) — no change; just confirm.
- [ ] **Step 3:** `npm run typecheck` (or `tsc --noEmit`) in packages/web → clean. `npm run build -w @polyant/web` optional. Commit.

## Task W2: Hooks config tab — function picker + streaming warning

**Files:** Modify `src/app/(admin)/instances/[slug]/hooks-tab.tsx`; `src/lib/i18n/locales/{en,it}.json`.

- [ ] **Step 1: i18n.** In BOTH `en.json` and `it.json`, in the `hooks.*` block: add `hooks.function`, `hooks.functionPlaceholder`, `hooks.functionRequired`, `hooks.unknownFunction`, `hooks.streamingWarning` (e.g. EN "This hook can replace the response — affected turns won't be streamed." / IT "Questo hook può modificare la risposta: i turni interessati non verranno inviati in streaming."); reword `hooks.dialogDescription` + `hooks.deleteDescription` to reference a "function" not a "tool"; REMOVE the now-unused `hooks.tool`, `hooks.toolPlaceholder`, `hooks.toolRequired`, `hooks.unknownTool`, `hooks.args`, `hooks.argsHint`, `hooks.invalidArgsJson` (delete from both files — an unused key in en.json is fine, but a key in en.json missing from it.json breaks the build, so keep the two files in lockstep).
- [ ] **Step 2: Fetch the catalog.** Replace the `api.tools.catalog()` fetch with `api.hooks.functions()`; store `HookFunctionInfo[]`. Remove tool-catalog state.
- [ ] **Step 3: Form.** Replace the tool-picker shadcn `Select` (options from tools) with a function-picker `Select` (options from the catalog: `name`, showing `description` as helper text under the select). REMOVE the args JSON `Textarea` + its state (`argsText`) + the JSON parse/validation. Keep `event`, `timeoutMs`, `position`, `enabled`.
- [ ] **Step 4: Streaming warning.** When the selected function has `mutatesResponse === true`, render an inline warning under the picker — a muted/`text-destructive`-adjacent note using `t("hooks.streamingWarning")` (style per design system: small, `text-xs`, an alert-ish inline block, not a heavy banner).
- [ ] **Step 5: Submit shape.** Change create/update payload `actionConfig` from `{ toolName, args }` to `{ functionName }` (the selected function name). Drop `args`.
- [ ] **Step 6:** Web `tsc --noEmit` clean; render check if feasible. Commit.

## Task W3: Hook-execution pill — relabel tool→function

**Files:** Modify `src/components/messages/hook-execution-pill.tsx`; i18n if it has hardcoded "tool" copy.

- [ ] **Step 1:** The engine keeps the `toolName` field on the execution view but it now carries the FUNCTION name. Update the pill's COPY/labels that say "tool" to say "function" (via i18n key, e.g. reuse/add `hooks.function`). The field read stays `toolName` (no engine rename) — only the human-facing label changes. If the pill shows an `args` section that's now always empty (hook functions don't have template args), hide the args block when `args` is empty/undefined so the pill doesn't show an empty "Input" panel.
- [ ] **Step 2:** Web `tsc --noEmit` clean. Commit.

## Task W4: Provenance badge on hook-authored assistant messages

**Files:** Modify `src/app/(admin)/conversations/[conversationId]/page.tsx` + `src/app/(admin)/playground/_components/message-bubble.tsx`; i18n.

- [ ] **Step 1: i18n.** Add `message.provenance.hook` to both locales, e.g. EN `"via hook «{name}»"`, IT `"da hook «{name}»"` (uses the `{name}` param).
- [ ] **Step 2: Badge.** In BOTH assistant-message render sites, when `metadata?.source === "hook"`, render a small badge/caption near the assistant bubble (e.g. `text-xs text-muted-foreground` with a subtle `Badge` or inline pill) showing `t("message.provenance.hook", { name: String(metadata.hookName ?? "") })`. Only for `role === "assistant"` with that metadata. Keep it unobtrusive (design system: caption style, not accent). Reuse a shared tiny helper/component if both sites would duplicate >3 lines.
- [ ] **Step 3:** Web `tsc --noEmit` clean; visually check both surfaces if feasible. Commit.

## Task W5: Web verification

- [ ] `npm run lint -w @polyant/web` → 0 errors (react-compiler rules are `warn` per CLAUDE.md).
- [ ] `npm run build -w @polyant/web` → succeeds (Next build = the real typecheck gate for the web).
- [ ] Confirm no remaining references to the removed i18n keys (`hooks.tool`, `hooks.args*`, `hooks.invalidArgsJson`, `hooks.unknownTool`) anywhere in `src/`.
- [ ] Commit any fixups.

---

## Self-review notes (author)
- Spec §7 coverage: function picker (W2), streaming warning (W2), hook chip relabel (W3), provenance badge (W4), catalog client (W1). All covered.
- The engine keeps the `toolName` field carrying the function name → W3 is copy-only, no data-shape churn. Provenance uses the `metadata.source`/`metadata.hookName` the engine persists (T8).
- i18n: every added key goes in BOTH en.json + it.json; removed keys deleted from both in lockstep (build fails on mismatch).
