# Wave 1 — Close the Leaks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop three ways a secret or an unauthenticated caller gets in: give OSS back the control that closes an agent's open HTTP surface, keep skill secrets out of the model's context entirely, and stop the loggers from writing the fields they were told not to write.

**Architecture:** Three independent changes on one branch. 1a is a pure back-port of an existing enterprise panel — no engine change, the fields it edits already exist in OSS. 1b introduces a placeholder indirection: `readSkill` emits `{{skill_env.<skill>.<KEY>}}` for keys the operator marked sensitive, and `buildTool`'s `wrappedExecute` substitutes the real value after validation and immediately before `def.execute`, so the plaintext exists only inside the tool call. 1c extracts one serializer that both `installFileLogger` and the audit output-preview use, so an `Error`'s custom fields and any key that looks like a credential never reach disk.

**Tech Stack:** TypeScript ESM, NestJS 11, Next.js 16 + React 19, Drizzle ORM, vitest, Zod, `@polyant-ai/plugin-sdk`.

**Spec:** No separate spec document. The design was settled in conversation on 2026-08-28 and is restated in each task's rationale; the audit that motivated it is the eleven-agent sweep of `6e480c0`. The two decisions that shaped it: the operator keeps `auth_enabled` defaulting to `false` (the defect is the missing control, not the default), and the model must never see a sensitive value (placeholder substitution, not boundary redaction).

## Global Constraints

- Base branch: `chore/audit-remediation`, itself branched from `origin/develop` at `f07722f`. All waves land on this one branch; one PR at the end.
- Every commit must carry a DCO sign-off (`git commit -s`). Enforced by `.github/workflows/dco.yml`; PRs without it cannot merge.
- Conventional-commit subjects, English, atomic: one commit = one logical change.
- `packages/engine`: relative imports MUST end in `.js`. `packages/web`: relative value imports MUST be extensionless (Next's bundler does not map `./x.js` onto `x.ts`).
- Every new source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later` followed by a blank line.
- `packages/web` locale files must stay at exact key parity — `lib/i18n/locales.test.ts` reads them as raw text and fails on a missing key OR a duplicate one. Every new key goes into BOTH `en.json` and `it.json`.
- Tool `parameters` must satisfy OpenAI strict mode. Not exercised by this wave (no new tool), but `agents/tools/strict-mode.test.ts` runs over the whole registry on every unit run.
- Gate before each commit: `npm run typecheck` (must be clean) and `npm run test:unit -w @polyant/engine` (baseline is **242 files, 2880 passed, 3 skipped**; `npm run lint` has a **pre-existing** 56 warnings / 0 errors — do not treat those 56 as a regression, but do not add to them).

---

### Task 1: Back-port the Web/API panel to OSS

The panel's status page already tells an operator that an agent with `auth_enabled = false` is `broken` and links them to the Channels section. The control that fixes it was moved into the Web/API channel card, and that card was then deleted from OSS as an "Enterprise channel" — which is wrong: `CHANNEL_TYPES` is `["telegram","slack","whatsapp","agent","http"]` in **enterprise too**. `web` is not a channel in either build; it is a UI panel over `instances.authEnabled` plus the `auth_api_key` secret, both of which OSS already has. Only `http` is genuinely enterprise.

So the destination is a real tab with nothing in it, and the only way to close an agent's open HTTP surface today is a hand-written `PATCH` or a SQL update.

**Files:**
- Create: `packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/instances/[slug]/channel-web-tab.tsx`
- Create: `packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/instances/[slug]/channel-web-tab.test.tsx`
- Modify: `packages/web/src/app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/instances/[slug]/channels-section.tsx` — the `CHANNELS` array, its docblock, the `Globe` import, and the render branch
- Modify: `packages/web/src/lib/i18n/locales/en.json` and `it.json` — three new keys

**Interfaces:**
- Consumes: `useInstanceSecret(slug, key)` — **two** parameters in OSS. The enterprise copy passes a third (`organization`) which does not exist here; drop it. `SECRET_KEYS.AUTH` is `"auth_api_key"` (`lib/provider-secrets.ts:22`). `usePageSaveAction({ isDirty, saving, onSave })` from `./page-actions-context`. `api.instances.update(slug, { authEnabled })`.
- Produces: `ChannelWebTab({ instance, onUpdate })`, rendered by `channels-section.tsx` when the picked channel is `"web"`.

- [ ] **Step 1: Write the failing test**

`channel-web-tab.test.tsx`. Mock `@/lib/api` and the secret hook; assert the switch reflects `instance.authEnabled`, that saving writes the key BEFORE the flag, and that the key field is hidden while auth is off.

```tsx
it("saves the API key before flipping the flag on", async () => {
  const order: string[] = [];
  saveSecret.mockImplementation(async () => { order.push("secret"); });
  updateInstance.mockImplementation(async () => { order.push("flag"); return { instance: { ...instance, authEnabled: true } }; });

  render(<ChannelWebTab instance={{ ...instance, authEnabled: false }} onUpdate={onUpdate} />);
  await userEvent.click(screen.getByRole("switch"));
  await act(() => savePage());

  expect(order).toEqual(["secret", "flag"]);
});
```

The ordering is the point, not ceremony: flipping the flag first with a failing key write leaves the agent refusing every caller.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w @polyant/web -- channel-web-tab`
Expected: FAIL — cannot resolve `./channel-web-tab`.

- [ ] **Step 3: Create the component**

Copy the enterprise file verbatim, then make exactly two changes: drop the third argument to `useInstanceSecret`, and keep the docblock's explanation of why `auth_api_key` is agent-only (it is deliberately absent from `ORG_SHAREABLE_SECRET_KEYS`, because one org-level key would authenticate every agent) while removing the sentence about the `null` organization the OSS hook has no parameter for.

- [ ] **Step 4: Add the three locale keys to both files**

`channels.tab.web`, `channels.tab.webHelp`, `channels.tab.webAuthHelp`. The other six keys the component uses already exist in OSS. The help copy must say that the switch governs EVERY api route that speaks to this agent — the OpenAI-compatible endpoint, the native streaming endpoint and the CLI alias — not only the one whose name the reader happens to remember.

- [ ] **Step 5: Wire it into the picker**

In `channels-section.tsx`: import `Globe` from `lucide-react` and `ChannelWebTab` from `./channel-web-tab`; put `{ type: "web", titleKey: "channels.tab.web", icon: Globe }` FIRST in `CHANNELS`; and branch the render — `selected === "web" ? <ChannelWebTab … /> : <ChannelsTab … />`.

Replace the docblock that says Web/API is an Enterprise channel with one that says what is true: `web` is not a channel type in either build, it is the always-present HTTP surface; `http` is the enterprise channel and stays out. Leave the existing comment about the picker's dots alone — it already reasons correctly that the Web/API panel reports no channel list.

- [ ] **Step 6: Run the test, then the gate**

Run: `npm run test -w @polyant/web -- channel-web-tab` → PASS.
Then `npm run typecheck`, and confirm the status check now has a destination that contains a control.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/app packages/web/src/lib/i18n/locales
git commit -s -m "fix(web): give OSS back the switch that closes an agent's HTTP surface"
```

---

### Task 2: Keep sensitive skill env out of the model's context

`instance_skill_env` already records which values are sensitive: `setSkillEnv` writes `encrypted: params.sensitive` and encrypts with AES-256-GCM. `getSkillEnv` then decrypts everything into a flat `Record<string, string>` and **drops the flag**, and `readSkill` — one of only two tools enabled by default on every agent — interpolates those plaintext values into its result inside a `<skill_env>` block. The model receives the credential; so does `tool_audit_logs`, which stores an unredacted `JSON.stringify` of every tool result, making the audit table a second, cleartext copy of what the encryption at rest exists to protect.

The fix is indirection, not redaction: the model gets a placeholder it can move around but cannot read, and the engine swaps in the real value at the last moment.

**Files:**
- Modify: `packages/engine/src/instances/skill-env.store.ts` — add `getSkillEnvEntries`
- Create: `packages/engine/src/agents/tools/shared/skill-env-placeholder.ts`
- Create: `packages/engine/src/agents/tools/shared/skill-env-placeholder.test.ts`
- Modify: `packages/engine/src/agents/tools/read-skill.tool.ts:66-72`
- Modify: `packages/engine/src/agents/tools/registry.ts` — `buildTool`'s `wrappedExecute`
- Test: `packages/engine/src/agents/tools/read-skill.tool.test.ts`, `packages/engine/src/agents/tools/registry.test.ts`

**Interfaces:**
- Produces: `getSkillEnvEntries(instanceSlug, skillSlug): Promise<Array<{ key: string; value: string; sensitive: boolean }>>` — the existing `getSkillEnv` keeps its signature and its three call sites untouched.
- Produces: `PLACEHOLDER_RE`, `hasPlaceholder(value: unknown): boolean`, and `substituteSkillEnv(value: unknown, instanceId: InstanceSlug): Promise<unknown>` from `skill-env-placeholder.ts`.
- Placeholder grammar: `{{skill_env.<skillSlug>.<KEY>}}`. Qualified by skill because env is scoped per `(instance, skill)` and two skills may legitimately define the same key name.

- [ ] **Step 1: Write the failing test for the substituter**

```ts
it("replaces a qualified placeholder anywhere in the argument tree", async () => {
  getSkillEnvEntries.mockResolvedValue([{ key: "CRM_TOKEN", value: "sk-live-a91f", sensitive: true }]);
  const out = await substituteSkillEnv(
    { headers: { Authorization: "Bearer {{skill_env.crm-sync.CRM_TOKEN}}" }, n: 3 },
    asInstanceSlug("acme"),
  );
  expect(out).toEqual({ headers: { Authorization: "Bearer sk-live-a91f" }, n: 3 });
});

it("leaves an unknown placeholder untouched rather than emptying it", async () => {
  getSkillEnvEntries.mockResolvedValue([]);
  const out = await substituteSkillEnv("{{skill_env.crm-sync.NOPE}}", asInstanceSlug("acme"));
  expect(out).toBe("{{skill_env.crm-sync.NOPE}}");
});

it("does not touch a non-sensitive value's placeholder form", async () => {
  // A non-sensitive var is emitted inline by readSkill, so a placeholder naming
  // one is a model invention, not our contract. Substituting it would be a way
  // to probe for key existence.
  getSkillEnvEntries.mockResolvedValue([{ key: "REGION", value: "eu-west-1", sensitive: false }]);
  const out = await substituteSkillEnv("{{skill_env.crm-sync.REGION}}", asInstanceSlug("acme"));
  expect(out).toBe("{{skill_env.crm-sync.REGION}}");
});
```

Leaving an unknown placeholder alone is deliberate. Replacing it with an empty string would send a request with `Authorization: Bearer ` and produce a confusing 401 instead of a legible failure.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --root packages/engine src/agents/tools/shared/skill-env-placeholder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the substituter**

```ts
export const PLACEHOLDER_RE = /\{\{skill_env\.([a-z0-9][a-z0-9_-]*)\.([A-Z0-9_]+)\}\}/g;

export function hasPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return PLACEHOLDER_RE.test(value.slice());
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === "object") return Object.values(value).some(hasPlaceholder);
  return false;
}
```

`PLACEHOLDER_RE` is global, so it carries `lastIndex` between calls — reset it (`PLACEHOLDER_RE.lastIndex = 0`) before each `test`/`replace` sweep, or build a fresh RegExp per call. Getting this wrong makes substitution succeed on the first tool call of a turn and silently skip the second.

`substituteSkillEnv` walks the tree, collects every `(skill, key)` pair first, resolves each skill's entries **once** (a Map keyed by skill slug — a tool call carrying five placeholders from one skill must not issue five queries), and replaces only pairs whose entry exists AND has `sensitive: true`.

- [ ] **Step 4: Run the tests → PASS**

- [ ] **Step 5: Write the failing test for `readSkill`**

```ts
it("emits a placeholder for a sensitive var and the value for a plain one", async () => {
  getSkillEnvEntries.mockResolvedValue([
    { key: "CRM_TOKEN", value: "sk-live-a91f", sensitive: true },
    { key: "REGION", value: "eu-west-1", sensitive: false },
  ]);
  const res = await readSkill.execute({ name: "crm-sync" }, ctx) as { content: string };
  expect(res.content).toContain('<var name="CRM_TOKEN" value="{{skill_env.crm-sync.CRM_TOKEN}}" sensitive />');
  expect(res.content).toContain('<var name="REGION">eu-west-1</var>');
  expect(res.content).not.toContain("sk-live-a91f");
});
```

The last assertion is the one that matters. Keep it phrased as "the plaintext does not appear", not "the placeholder does" — it is the property being defended.

- [ ] **Step 6: Change `readSkill` to use `getSkillEnvEntries`**

Sensitive → `<var name="K" value="{{skill_env.<slug>.K}}" sensitive />`. Plain → today's `<var name="K">value</var>`. Add one line to the block telling the model that a `value="{{…}}"` placeholder is to be passed through verbatim into a tool argument and is not readable — otherwise a model that has never seen the form may try to "resolve" it or report it as missing.

- [ ] **Step 7: Wire substitution into `buildTool`**

In `wrappedExecute` (`registry.ts`), before `def.execute(input, ctx)`:

```ts
const resolved = hasPlaceholder(input) ? await substituteSkillEnv(input, ctx.instanceId) : input;
```

Guarded by `hasPlaceholder` so the overwhelming majority of tool calls pay a synchronous tree walk and no query at all. Log the tool call with the ORIGINAL `input` (`pipelineLog.toolCall` already runs before this) — logging the resolved value would reintroduce the leak in the place we are trying to close.

- [ ] **Step 8: Add the registry test**

Assert that `buildTool`'s execute receives the substituted value while `pipelineLog.toolCall` received the placeholder. Both halves; the second is the regression guard.

- [ ] **Step 9: Run the gate**

`npm run typecheck` clean, `npm run test:unit -w @polyant/engine` at 242 files with the new tests added to the count.

- [ ] **Step 10: Commit**

```bash
git add packages/engine/src
git commit -s -m "fix(skills): the model gets a placeholder, never a sensitive skill secret"
```

---

### Task 3: One serializer for anything that reaches a log or the audit table

`installFileLogger` patches `console.error` process-wide and serializes non-string arguments with `JSON.stringify`. `Error.message` and `.stack` are non-enumerable, so that call **discards the diagnostic text and keeps the custom fields** — and driver-level errors from pg, the AWS SDK and fetch routinely carry the connection string, the request config or the `authorization` header on the error object. `index.ts` already states this policy for the process-level handlers (`fatalDetail`: stack or message, never custom fields); the file logger, which is where things actually land for fourteen days, does the opposite.

`safeOutputPreview` in `agents/supervisor/index.ts` has the same shape and worse reach: a bare `JSON.stringify` of every tool result, with no cap and no redaction, written to `tool_audit_logs.output`. Its docblock claims it is "truncated". It is not.

**Files:**
- Create: `packages/engine/src/utils/serialize-for-log.ts`
- Create: `packages/engine/src/utils/serialize-for-log.test.ts`
- Modify: `packages/engine/src/utils/file-logger.ts:73`
- Modify: `packages/engine/src/agents/supervisor/index.ts` — `safeOutputPreview`

**Interfaces:**
- Produces: `serializeForLog(value: unknown, opts?: { maxLength?: number }): string`. Default cap 4000 characters, truncation marked `…[truncated N chars]`.
- Rules, in order: an `Error` becomes `stack ?? message` and nothing else; any object key matching `/(authorization|api[-_]?key|token|secret|password|passwd|credential|connection[-_]?string|cookie|bearer)/i` has its value replaced with `"[redacted]"` regardless of depth; the result is capped.

- [ ] **Step 1: Write the failing test**

```ts
it("keeps an Error's stack and drops its custom fields", () => {
  const err = Object.assign(new Error("boom"), {
    url: "https://api.example.com/v1?key=sk-live-a91f",
    responseHeaders: { authorization: "Bearer sk-live-a91f" },
  });
  const out = serializeForLog(err);
  expect(out).toContain("boom");
  expect(out).not.toContain("sk-live-a91f");
});

it("redacts a credential-shaped key at any depth", () => {
  const out = serializeForLog({ a: { b: { apiKey: "sk-live-a91f", n: 1 } } });
  expect(out).toContain('"apiKey":"[redacted]"');
  expect(out).toContain('"n":1');
});

it("caps a long value and says so", () => {
  const out = serializeForLog({ blob: "x".repeat(10_000) }, { maxLength: 200 });
  expect(out.length).toBeLessThan(260);
  expect(out).toMatch(/…\[truncated \d+ chars\]$/);
});

it("never throws on a circular structure", () => {
  const a: Record<string, unknown> = {}; a.self = a;
  expect(() => serializeForLog(a)).not.toThrow();
});
```

The `Error` case is the whole reason this file exists — verify empirically that `JSON.stringify(err)` really does drop `message` before trusting the fix.

- [ ] **Step 2: Run and watch it fail** — module not found.

- [ ] **Step 3: Implement `serializeForLog`**

Use a `JSON.stringify` replacer for redaction plus a `WeakSet` for cycles. Handle the `Error` case before stringifying at all, and handle an `Error` nested inside an object via the replacer too.

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Use it in `file-logger.ts`**

Replace `typeof a === "string" ? a : JSON.stringify(a)` with `typeof a === "string" ? a : serializeForLog(a)`.

- [ ] **Step 6: Use it in `safeOutputPreview`**

`return serializeForLog(output)` — which finally makes the function's name and its docblock true, and stops the audit table from holding a plaintext copy of whatever a tool returned. Keep the existing `undefined` behaviour for `null` / `"null"` / `"undefined"`.

- [ ] **Step 7: Run the gate**

Watch for tests that assert on exact audit output — if one breaks, that is a real behaviour change and the assertion should be updated to the redacted shape, not the check softened.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src
git commit -s -m "fix(logging): one serializer, and it stops writing the fields the policy forbids"
```

---

## Deliberately out of scope for this wave

Named here so the next reader does not assume they were missed:

- **The Git token written into the conversation sandbox** (`git-clone-repo.tool.ts` writes `.git/polyant-token` inside the directory `readFile` may read). Same family as Task 2, excluded by decision on 2026-08-28.
- **`ctx.apiKeys` bypassing `scopeSecrets`** — every tool and hook receives the instance's LLM provider credentials undeclared, one line below the scoped `secrets`. Same family, same decision.
- **The webhook payload choosing the outbound recipient and the conversation id.** Excluded by decision; partially narrowed upstream by `9fa4a43d`.
- **Three tenancy predicates that still fail open** (`memory/memory-store.ts:256`, `instances/store.ts:175` and `:255`). Named in CLAUDE.md as known debt by Wave 0; the fix is a behaviour change that needs its own tests, and belongs with Wave 3's coverage work.

## Self-review

**Spec coverage.** Three decisions were settled in conversation: keep the `auth_enabled` default and restore the missing control (Task 1); placeholder substitution rather than boundary redaction (Task 2); a shared serializer for the file logger, with the audit preview folded in because it is the same defect with a wider blast radius (Task 3). All three have tasks. The out-of-scope list accounts for everything discussed and excluded.

**Placeholder scan.** No TBDs. Each code step carries the actual code or the exact edit. The two steps that say "copy the enterprise file" name the two changes required, which is the whole diff.

**Type consistency.** `getSkillEnvEntries` returns `Array<{key, value, sensitive}>` in Task 2's interface block, its test, and its `readSkill` consumer. `substituteSkillEnv(value, instanceId)` and `hasPlaceholder(value)` keep their argument order between the substituter's test and the `registry.ts` call site. `serializeForLog(value, opts?)` is used identically in its own test, `file-logger.ts` and `safeOutputPreview`. `useInstanceSecret` is two-argument throughout Task 1 — the difference from enterprise that would otherwise pass typecheck as an ignored extra argument and then read the wrong hook overload.
