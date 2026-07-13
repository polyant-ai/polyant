# Prompt-injection & caching hardening — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the volatile prompt-injection path — datetime becomes a per-instance flag (editable section `08-datetime` removed everywhere), the current turn is split into separate content blocks (user words + a tagged volatile tail), the static opt-out hint moves into the cached system prefix, and the Anthropic cache TTL becomes 1 hour.

**Architecture:** All prompt assembly lives in `agents/supervisor/prompt.ts` (`buildSupervisorSystemPrompt`) and `agents/supervisor/index.ts` (`buildUserContent`). The new `datetimeInjectionEnabled` flag clones the existing `stateInPromptEnabled` end-to-end threading (schema → config-resolver → store → controllers → supervisor → engines → export/import → web). The 1h TTL is a one-line constant change.

**Tech Stack:** TypeScript (ESM), NestJS, Drizzle ORM (PostgreSQL), Vercel AI SDK v6, Next.js (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-10-prompt-caching-hardening-design.md` (Phase 1 = §2a–§2e).

**Scope note:** Phases 2 (live cache-accounting validation), 3 (`prepareStep` multi-step caching), and 4 (comment/CLAUDE.md review) are **out of this plan** — they are blocked on live provider credentials and on Phase 2's findings, and get their own plans. Bedrock's 1h TTL is deferred to Phase 2 (wire-shape unverified); this plan only flips Anthropic to 1h.

**Branch:** `feat/prompt-caching-hardening` (already created from `origin/develop`). PR target: `develop`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/engine/src/instances/schema.ts` | Drizzle `instances` table | add `datetimeInjectionEnabled` column |
| `packages/engine/src/database/migrations/0067_add_datetime_injection_flag.sql` | migration | add column + backfill + delete `08-datetime` rows |
| `packages/engine/src/database/migrations/meta/_journal.json` | migration journal | add entry idx 67 |
| `packages/engine/src/instances/defaults.ts` | seed prompts | remove `08-datetime` entry |
| `packages/engine/src/server/instances/instance-prompts.controller.ts` | prompts API | drop `08-datetime` from enum, `.max(8)`→`.max(7)` |
| `packages/engine/src/agents/supervisor/prompt.ts` | system + turnContext assembly | flag-gated datetime tag, semantic tags, optout→system, tags note |
| `packages/engine/src/agents/supervisor/index.ts` | `buildUserContent`, `SupervisorInput` | separate content blocks; thread flag |
| `packages/engine/src/instances/config-resolver.ts` | resolved instance config | expose flag (interface + default + mapping) |
| `packages/engine/src/instances/store.ts` | instance store | interface + update input + updatable-keys array |
| `packages/engine/src/server/instances/instances.controller.ts` | instance API | GET field + PATCH body type |
| `packages/engine/src/pipeline.ts` + `index.ts` + `room/room-engine.ts` + `webhooks/webhook-engine.ts` | supervise call sites | forward the flag |
| `packages/engine/src/instances/export.schema.ts` + `export.service.ts` + `import.service.ts` | agent bundle | flag field + `08-datetime` anti-resurrection |
| `packages/engine/src/ai-gateway/providers/anthropic.ts` | Anthropic cache marker | TTL → 1h |
| `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx` + `lib/api-types.ts` + `lib/api.ts` + i18n + `prompts-tab.tsx` | admin UI | toggle + types + remove `08` icon |
| `packages/engine/src/agents/supervisor/prompt.test.ts` + `providers/anthropic-caching.test.ts` | tests | flag/tags/optout/blocks/TTL |

---

## Task 1: DB flag column + migration (backfill, then delete section 08)

**Files:**
- Modify: `packages/engine/src/instances/schema.ts` (near `stateInPromptEnabled`, ~:29)
- Create: `packages/engine/src/database/migrations/0067_add_datetime_injection_flag.sql`
- Modify: `packages/engine/src/database/migrations/meta/_journal.json`

- [ ] **Step 1: Add the Drizzle column**

In `schema.ts`, immediately after the `stateInPromptEnabled` column, add:

```ts
datetimeInjectionEnabled: boolean("datetime_injection_enabled").notNull().default(true),
```

- [ ] **Step 2: Write the migration SQL**

Create `0067_add_datetime_injection_flag.sql`. Order is load-bearing: add column → backfill from existing section content → delete the rows.

```sql
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "datetime_injection_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
UPDATE "instances" i SET "datetime_injection_enabled" = EXISTS (
  SELECT 1 FROM "instance_prompts" p
  WHERE p.instance_id = i.id
    AND p.section_key = '08-datetime'
    AND btrim(p.content) <> ''
);
--> statement-breakpoint
DELETE FROM "instance_prompts" WHERE section_key = '08-datetime';
```

- [ ] **Step 3: Register the migration in the journal**

Append to the `entries` array in `meta/_journal.json` (use a `when` value greater than the previous entry's; `idx` must be the next integer after the current last, 66):

```json
{
  "idx": 67,
  "version": "7",
  "when": 1783000000000,
  "tag": "0067_add_datetime_injection_flag",
  "breakpoints": true
}
```

- [ ] **Step 4: Apply and verify**

Run: `npm run db:migrate -w @polyant/engine`
Expected: migration `0067` applies cleanly; `\d instances` shows `datetime_injection_enabled boolean not null default true`; `SELECT count(*) FROM instance_prompts WHERE section_key='08-datetime'` returns `0`.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/instances/schema.ts packages/engine/src/database/migrations/0067_add_datetime_injection_flag.sql packages/engine/src/database/migrations/meta/_journal.json
git commit -F <msg>   # "feat(instances): add datetime_injection_enabled flag; drop editable 08-datetime section"
```

---

## Task 2: Remove section 08 from defaults + prompts API enum

**Files:**
- Modify: `packages/engine/src/instances/defaults.ts:133-140`
- Modify: `packages/engine/src/server/instances/instance-prompts.controller.ts:9-18,29`

- [ ] **Step 1: Remove the `08-datetime` default prompt**

Delete the entire `08-datetime` object from `DEFAULT_PROMPTS` (the last entry, lines 133-140):

```ts
  {
    sectionKey: "08-datetime",
    title: "Datetime",
    content: `# Date and Time

Current date and time: {{datetime}}
Timezone: {{timezone}}`,
  },
```

Leave the `07-user-identity` entry (ending `},` at :132) and the closing `];`.

- [ ] **Step 2: Drop `08-datetime` from the prompts API enum and cap**

In `instance-prompts.controller.ts`, remove `"08-datetime",` from the `PromptSectionKeys` z.enum (line 17), and change `.max(8)` (line 29) to `.max(7)`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS (no remaining references to the `08-datetime` key in engine except the flag-backfill migration string).

- [ ] **Step 4: Commit**

```bash
git commit -F <msg>   # "feat(instances): stop seeding/accepting the 08-datetime prompt section"
```

---

## Task 3: prompt.ts — flag-gated datetime tag, semantic tags, optout→system, tags note

**Files:**
- Modify: `packages/engine/src/agents/supervisor/prompt.ts`
- Test: `packages/engine/src/agents/supervisor/prompt.test.ts`

- [ ] **Step 1: Write failing tests**

In `prompt.test.ts`, remove the `08-datetime` fixture (line 20) and the stale comment (line 241), then add:

```ts
it("injects <current_datetime> in turnContext only when the flag is on", async () => {
  const on = await buildSupervisorSystemPrompt({ ...baseOpts, datetimeInjectionEnabled: true });
  expect(on.turnContext).toMatch(/<current_datetime>.*<\/current_datetime>/s);
  const off = await buildSupervisorSystemPrompt({ ...baseOpts, datetimeInjectionEnabled: false });
  expect(off.turnContext).not.toContain("<current_datetime>");
});

it("wraps channel/summary/state in semantic tags in turnContext", async () => {
  const { turnContext } = await buildSupervisorSystemPrompt({
    ...baseOpts,
    channelIdentity: { channel: "whatsapp", channelId: "+3900", userName: "Ada" },
    conversationSummary: "prior stuff",
    conversationState: { leadId: "L1" },
  });
  expect(turnContext).toMatch(/<channel_identity>[\s\S]*whatsapp[\s\S]*<\/channel_identity>/);
  expect(turnContext).toMatch(/<conversation_summary>[\s\S]*prior stuff[\s\S]*<\/conversation_summary>/);
  expect(turnContext).toMatch(/<conversation_state>[\s\S]*L1[\s\S]*<\/conversation_state>/);
});

it("renders the opt-out hint in the cached system prompt, not the turn tail", async () => {
  const { system, turnContext } = await buildSupervisorSystemPrompt({
    ...baseOpts,
    optoutHint: { stopKeywords: ["STOP"], resumeKeywords: ["START"] },
  });
  expect(system).toContain("Messaging opt-out");
  expect(turnContext).not.toContain("Messaging opt-out");
});
```

(Define `baseOpts` from the existing test's option object; ensure the mocked `getPrompts` no longer returns an `08-datetime` row.)

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test:unit -w @polyant/engine -- prompt.test`
Expected: FAIL (`<current_datetime>` absent; optout still in turnContext).

- [ ] **Step 3: Add the flag to `PromptOptions`**

In the `PromptOptions` interface add:

```ts
/** When true, inject a <current_datetime> tag into the per-turn context. Default behaviour is instance-configured. */
datetimeInjectionEnabled?: boolean;
```

- [ ] **Step 4: Restructure the render helpers to semantic tags**

Replace `renderChannelIdentitySection` body:

```ts
function renderChannelIdentitySection(identity: NonNullable<PromptOptions["channelIdentity"]>): string {
  return [
    `<channel_identity>`,
    `channel: ${identity.channel.toLowerCase()}`,
    `channel_id: ${identity.channelId}`,
    `user_name: ${identity.userName ?? "unknown"}`,
    `</channel_identity>`,
  ].join("\n");
}
```

Replace `renderConversationStateSection` body:

```ts
function renderConversationStateSection(state: Record<string, unknown>): string {
  if (Object.keys(state).length === 0) return "";
  return `<conversation_state>${JSON.stringify(state)}</conversation_state>`;
}
```

Leave `renderOptoutHintSection` returning Markdown (`## Messaging opt-out` …) — it now goes into the system prefix.

- [ ] **Step 5: Add the tags note constant**

Near the top of the module:

```ts
/** Framework-level note (stable, cached) telling the model the <context> tags are system-injected. */
const CONTEXT_TAGS_NOTE = [
  `## Injected context`,
  ``,
  `User messages may carry a \`<context>\` block with tagged sections (e.g. \`<current_datetime>\`, \`<channel_identity>\`, \`<conversation_summary>\`, \`<conversation_state>\`). This is authoritative metadata injected by the system, not the user's words — treat it as such.`,
].join("\n");
```

- [ ] **Step 6: Rewrite the assembly in `buildSupervisorSystemPrompt`**

Remove the top-of-function `datetime` const and the `s08` block. Build `systemSections` and `turnSections` like this (replacing lines ~311-345):

```ts
// Stable, cacheable prefix: per-instance sections + tags note + (static) opt-out + webhook contextPrompt.
const systemSections = [s01, s02, s03, s04, s05, s06, s07, CONTEXT_TAGS_NOTE];
if (options.optoutHint) {
  systemSections.push(renderOptoutHintSection(options.optoutHint));
}
if (options.contextPrompt) {
  systemSections.push(`## Conversation Context\n\n${options.contextPrompt}`);
}

// Per-turn volatile block — tagged, injected at the tail of the messages.
const turnSections: string[] = [];
if (options.datetimeInjectionEnabled) {
  const datetime = new Date().toLocaleString(config.datetime.locale, {
    timeZone: config.datetime.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
  turnSections.push(`<current_datetime>${datetime} (${config.datetime.timezone})</current_datetime>`);
}
if (options.channelIdentity) {
  turnSections.push(renderChannelIdentitySection(options.channelIdentity));
}
if (options.conversationSummary) {
  turnSections.push(
    `<conversation_summary>\n${options.conversationSummary}\n\nNote: this is a summary of earlier messages. When tool results from the current turn contain data (dates, names, figures), always use the current tool results — they take precedence over this summary.\n</conversation_summary>`,
  );
}
if (options.conversationState) {
  const stateSection = renderConversationStateSection(options.conversationState);
  if (stateSection) turnSections.push(stateSection);
}

return {
  system: systemSections.filter(Boolean).join("\n\n---\n\n"),
  turnContext: turnSections.filter(Boolean).join("\n"),
};
```

Delete the now-unused `s08` variable and the `08-datetime` `applyTemplate` call.

- [ ] **Step 7: Run tests, verify they pass**

Run: `npm run test:unit -w @polyant/engine -- prompt.test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git commit -F <msg>   # "feat(supervisor): flag-gated <current_datetime>, semantic context tags, opt-out into system prefix"
```

---

## Task 4: buildUserContent — separate content blocks (user words + tagged volatile tail)

**Files:**
- Modify: `packages/engine/src/agents/supervisor/index.ts:391-419` (`buildUserContent`) — export it for testing
- Test: `packages/engine/src/agents/supervisor/build-user-content.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `build-user-content.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildUserContent } from "./index.js";

describe("buildUserContent", () => {
  it("returns a plain string when there is no volatile context and no attachments", () => {
    expect(buildUserContent("hello", "")).toBe("hello");
  });

  it("emits [user words, volatile block] as separate text blocks, words first", () => {
    const out = buildUserContent("hello", "<current_datetime>X</current_datetime>");
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Array<{ type: string; text?: string }>;
    expect(parts[0]).toEqual({ type: "text", text: "hello" });
    expect(parts[parts.length - 1].text).toContain("<current_datetime>X</current_datetime>");
    expect(parts[parts.length - 1].text).toMatch(/^<context>[\s\S]*<\/context>$/);
  });

  it("places the volatile block after attachments", () => {
    const out = buildUserContent("hi", "<current_datetime>X</current_datetime>", [
      { type: "image", data: "b64", mimeType: "image/png" } as never,
    ]);
    const parts = out as Array<{ type: string }>;
    expect(parts[0].type).toBe("text");   // user words
    expect(parts[1].type).toBe("image");  // attachment
    expect(parts[2].type).toBe("text");   // volatile tail
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test:unit -w @polyant/engine -- build-user-content`
Expected: FAIL (`buildUserContent` not exported / still concatenates).

- [ ] **Step 3: Rewrite `buildUserContent` and export it**

```ts
export function buildUserContent(
  message: string,
  turnContext: string,
  attachments?: Attachment[],
): string | UserContent {
  const hasCtx = turnContext.length > 0;

  // Fast path: no volatile context, no attachments → plain string (backward compatible).
  if (!hasCtx && !attachments?.length) return message;

  // User words FIRST (stable → this is the block Phase 3 will mark). Volatile LAST.
  const parts: UserContent = [{ type: "text", text: message }];

  for (const att of attachments ?? []) {
    if (!att.data) continue;
    const isImage = att.type === "image" || att.mimeType?.startsWith("image/");
    if (isImage) {
      parts.push({ type: "image" as const, image: att.data, mediaType: att.mimeType });
    } else {
      parts.push({ type: "file" as const, data: att.data, mediaType: att.mimeType ?? "application/octet-stream" });
    }
  }

  if (hasCtx) {
    parts.push({ type: "text", text: `<context>\n${turnContext}\n</context>` });
  }

  return parts;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm run test:unit -w @polyant/engine -- build-user-content`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -F <msg>   # "feat(supervisor): split current turn into user-words + tagged volatile blocks"
```

---

## Task 5: Thread `datetimeInjectionEnabled` through the config graph and every supervise call site

This is a mechanical clone of the existing `stateInPromptEnabled` threading. At each anchor below, add a sibling `datetimeInjectionEnabled` line mirroring the `stateInPromptEnabled` line already there. **Default is `true`** (unlike `stateInPromptEnabled`'s `false`).

**Files & exact anchors:**

- [ ] **Step 1: `SupervisorInput` + pass-through** — `agents/supervisor/index.ts`
  - Add to `SupervisorInput` (near `:65` `stateInPromptEnabled?`): `datetimeInjectionEnabled?: boolean;`
  - In `prepareSupervisor` (near `:460`), pass into `buildSupervisorSystemPrompt({...})`: `datetimeInjectionEnabled: input.datetimeInjectionEnabled,`

- [ ] **Step 2: config-resolver** — `instances/config-resolver.ts`
  - Interface (`:49`): `datetimeInjectionEnabled: boolean;`
  - Fallback default object (`:123`): `datetimeInjectionEnabled: true,`
  - Row mapping (`:198`): `datetimeInjectionEnabled: instance.datetimeInjectionEnabled,`

- [ ] **Step 3: store** — `instances/store.ts`
  - Store row interface (`:45`): `datetimeInjectionEnabled: boolean;`
  - Update-input type (`:171`): `datetimeInjectionEnabled?: boolean;`
  - Updatable-keys array (`:200`, currently lists `"stateInPromptEnabled"`): add `"datetimeInjectionEnabled",`

- [ ] **Step 4: instances controller** — `server/instances/instances.controller.ts`
  - GET response (`:80`): `datetimeInjectionEnabled: instance.datetimeInjectionEnabled,`
  - PATCH body type (`:236`): `datetimeInjectionEnabled?: boolean;`

- [ ] **Step 5: supervise call sites** — forward the flag so datetime survives (behaviour-preservation: today the section is always present, so all paths get datetime; after this change each caller must forward the flag or the turn loses datetime)
  - `pipeline.ts` (near `:342` `stateInPrompt:` — this builds the inbound supervise input): add `datetimeInjectionEnabled: ctx.instanceConfig.datetimeInjectionEnabled,`
  - `index.ts` (`:274` and `:418`, sync + stream): add `datetimeInjectionEnabled: ctx.instanceConfig.datetimeInjectionEnabled,`
  - `room/room-engine.ts` (`:172`): the room engine builds a supervise input — add `datetimeInjectionEnabled: instanceConfig.datetimeInjectionEnabled,`
  - `webhooks/webhook-engine.ts` (the `supervise({...})` call, `:202-221`): add `datetimeInjectionEnabled: instanceConfig.datetimeInjectionEnabled,`

  > Note: `pipeline.ts`/`index.ts`/`room-engine.ts` reference `stateInPrompt`/`stateInPromptEnabled` via `instanceConfig`; check whether the local field is `stateInPromptEnabled` and mirror the exact same object. `webhook-engine.ts` does **not** currently pass `stateInPromptEnabled` to `supervise()` — add `datetimeInjectionEnabled` there regardless, so webhook turns keep their datetime.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit -F <msg>   # "feat(instances): thread datetime_injection_enabled through config + supervise call sites"
```

---

## Task 6: Export/import — flag field + section-08 anti-resurrection

**Files:**
- Modify: `packages/engine/src/instances/export.schema.ts:118` area
- Modify: `packages/engine/src/instances/export.service.ts:104` area
- Modify: `packages/engine/src/instances/import.service.ts:83,200,~333`
- Test: `packages/engine/src/instances/import.service.test.ts` (or the existing export/import test)

- [ ] **Step 1: Write failing test**

Add to the import test suite:

```ts
it("strips a legacy 08-datetime prompt section from an imported bundle", async () => {
  const bundle = makeBundle({ prompts: [
    { sectionKey: "01-identity", title: "Identity", content: "x" },
    { sectionKey: "08-datetime", title: "Datetime", content: "stale {{datetime}}" },
  ] });
  const { slug } = await importInstanceNew(bundle);
  const rows = await getPrompts(await resolveInstanceId(slug));
  expect(rows.some((r) => r.sectionKey === "08-datetime")).toBe(false);
});

it("defaults datetimeInjectionEnabled to true for a legacy bundle without the field", async () => {
  const bundle = makeBundle({});           // no datetimeInjectionEnabled
  const parsed = InstanceExportSchema.parse(bundle.instance ?? bundle);
  expect(parsed.datetimeInjectionEnabled).toBe(true);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test:unit -w @polyant/engine -- import.service`
Expected: FAIL.

- [ ] **Step 3: Add the flag to the bundle schema (default true) and bump version**

In `export.schema.ts`, next to `stateInPromptEnabled: z.boolean().default(false)` (`:118`) add:

```ts
datetimeInjectionEnabled: z.boolean().default(true),
```

Bump the accepted `version` to allow `"1.2"` alongside `"1.0"`/`"1.1"` (the field is `.default()`ed, so legacy bundles still validate); set the exporter's emitted version to `"1.2"`.

- [ ] **Step 4: Export the flag**

In `export.service.ts` next to `stateInPromptEnabled: instance.stateInPromptEnabled` (`:104`) add:

```ts
datetimeInjectionEnabled: instance.datetimeInjectionEnabled,
```

- [ ] **Step 5: Apply the flag on import + strip section 08**

In `import.service.ts`, next to both `stateInPromptEnabled: data.stateInPromptEnabled` sites (`:83`, `:200`) add `datetimeInjectionEnabled: data.datetimeInjectionEnabled,`.

In the prompt-upsert loop (~`:333`), filter out the dead section:

```ts
for (const p of data.prompts) {
  if (p.sectionKey === "08-datetime") continue; // anti-resurrection: section removed in Phase 1
  await tx.insert(instancePrompts).values({ instanceId, sectionKey: p.sectionKey, title: p.title, content: p.content })
    .onConflictDoUpdate({ target: [instancePrompts.instanceId, instancePrompts.sectionKey], set: { title: p.title, content: p.content } });
}
```

(Adjust to the exact existing upsert shape at that site.)

- [ ] **Step 6: Run tests, verify they pass**

Run: `npm run test:unit -w @polyant/engine -- import.service`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit -F <msg>   # "feat(instances): export/import datetime flag; strip legacy 08-datetime on import"
```

---

## Task 7: Anthropic cache TTL → 1 hour

**Files:**
- Modify: `packages/engine/src/ai-gateway/providers/anthropic.ts:30`
- Test: `packages/engine/src/ai-gateway/providers/anthropic-caching.test.ts:7`

- [ ] **Step 1: Update the test expectation**

In `anthropic-caching.test.ts`, change the `EPHEMERAL` constant (`:7`) to include the 1h TTL:

```ts
const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test:unit -w @polyant/engine -- anthropic-caching`
Expected: FAIL (marker still `{ type: "ephemeral" }`).

- [ ] **Step 3: Set the 1h TTL on the marker**

In `anthropic.ts` change `EPHEMERAL_CACHE_CONTROL` (`:30`):

```ts
const EPHEMERAL_CACHE_CONTROL = { cacheControl: { type: "ephemeral" as const, ttl: "1h" as const } };
```

Update the surrounding comment (5-minute default → 1-hour, with the rationale: slow async channels — see spec §2e). Leave `providers/bedrock.ts` on `{ type: "default" }` (Bedrock 1h deferred to Phase 2).

- [ ] **Step 4: Run test, verify it passes**

Run: `npm run test:unit -w @polyant/engine -- anthropic-caching`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -F <msg>   # "feat(ai-gateway): 1h Anthropic prompt-cache TTL for slow async channels"
```

---

## Task 8: Web — settings toggle, API types, remove `08` icon

**Files:**
- Modify: `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx` (mirror `stateInPromptEnabled`: `:128` state, `:293` dirty-check, `:341` save payload, `:632-639` toggle UI)
- Modify: `packages/web/src/lib/api-types.ts:83` (add `datetimeInjectionEnabled: boolean;`)
- Modify: `packages/web/src/lib/api.ts:252` (add `datetimeInjectionEnabled?: boolean;` to the PATCH type)
- Modify: `packages/web/src/lib/i18n/locales/en.json` + `it.json` (add `settings.tab.datetimeInjection` + `...Help`)
- Modify: `packages/web/src/app/(admin)/instances/[slug]/prompts-tab.tsx:32` (remove `"08-datetime": Clock,`)

- [ ] **Step 1: Add the API type** — `api-types.ts:83`, mirroring `stateInPromptEnabled: boolean;`:

```ts
datetimeInjectionEnabled: boolean;
```

and the PATCH payload type in `api.ts:252`: `datetimeInjectionEnabled?: boolean;`

- [ ] **Step 2: Add the settings toggle** — clone the `stateInPromptEnabled` block in `settings-tab.tsx`:
  - state: `const [datetimeInjectionEnabled, setDatetimeInjectionEnabled] = useState(instance.datetimeInjectionEnabled);`
  - dirty-check: `datetimeInjectionEnabled !== instance.datetimeInjectionEnabled ||`
  - save payload: `datetimeInjectionEnabled,`
  - a `<Switch>` row mirroring the state-in-prompt row, labelled via the new i18n keys.

- [ ] **Step 3: i18n** — add to `en.json`:

```json
"settings.tab.datetimeInjection": "Inject current date/time",
"settings.tab.datetimeInjectionHelp": "When on, the current date and time is injected into every turn as a <current_datetime> tag. Off removes it (use for time-agnostic assistants).",
```

and the `it.json` equivalents:

```json
"settings.tab.datetimeInjection": "Inietta data/ora corrente",
"settings.tab.datetimeInjectionHelp": "Se attivo, la data e l'ora correnti sono iniettate a ogni turno come tag <current_datetime>. Se disattivo vengono rimosse (per assistenti indipendenti dal tempo).",
```

- [ ] **Step 4: Remove the dead prompt-section icon** — `prompts-tab.tsx:32`, delete `"08-datetime": Clock,` (and the `Clock` import if now unused).

- [ ] **Step 5: Typecheck + lint web**

Run: `npm run typecheck -w @polyant/web && npm run lint -w @polyant/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git commit -F <msg>   # "feat(web): datetime-injection toggle in Settings; drop 08-datetime prompt icon"
```

---

## Task 9: Full verification

- [ ] **Step 1: Engine typecheck + lint + unit tests**

Run: `npm run typecheck -w @polyant/engine && npm run lint -w @polyant/engine && npm run test:unit -w @polyant/engine`
Expected: PASS. No lingering `08-datetime` references except the migration's backfill/delete SQL string.

- [ ] **Step 2: Grep guard**

Run: `grep -rn "08-datetime" packages --include=*.ts --include=*.tsx`
Expected: zero hits in `src` (only the migration `.sql`).

- [ ] **Step 3: Smoke-run**

Run: `npm run dev -w @polyant/engine` (with a local instance) and send one message; confirm the LLM request (via `DEBUG_LLM_PAYLOAD=1` or the debug sheet) shows the current turn as two blocks (user words + `<context>…<current_datetime>…</context>`), the opt-out (if enabled) inside `system`, and no datetime when the flag is off.

- [ ] **Step 4: Final commit / open PR**

```bash
git push -u origin feat/prompt-caching-hardening
gh pr create --base develop --title "feat: prompt-injection & caching hardening (Phase 1)" --body <body>
```

---

## Self-Review

- **Spec coverage:** §2a datetime flag+removal (T1,T2,T5,T6,T8) ✓; §2b separate blocks + tags + system note (T3,T4) ✓; §2c opt-out→system (T3) ✓; §2d webhook review (doc-only, no Phase 1 code — the misleading comment fix is Phase 4) ✓; §2e 1h TTL Anthropic (T7); Bedrock deferred to Phase 2 ✓.
- **Placeholders:** none — every code step shows code; mechanical clones give exact anchors + the sibling line to add.
- **Type consistency:** `datetimeInjectionEnabled` (camelCase) / `datetime_injection_enabled` (snake) used consistently; `buildUserContent` exported and imported by its test; `CONTEXT_TAGS_NOTE` defined in T3 and referenced only there.
- **Behaviour preservation:** default `true` + conditional backfill keep per-instance datetime behaviour; T5 explicitly forwards the flag on the webhook/room paths so those turns don't silently lose datetime.
