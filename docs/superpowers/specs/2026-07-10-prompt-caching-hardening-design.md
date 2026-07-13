# Prompt-injection & caching hardening — design

Date: 2026-07-10
Status: proposed (awaiting review)

## 1. Context & motivation

A read-only study of Polyant's prompt-caching path (supervisor prompt assembly +
`ai-gateway` providers) concluded the architecture is **sound and close to the
state of the art**: the big win — keeping the `system` prefix byte-stable by
pushing volatile content to the tail of `messages` — is already implemented
correctly, and the per-provider markers (Anthropic `cacheControl`, Bedrock
`cachePoint`, OpenAI automatic) are wired right.

The study surfaced refinements. This effort turns the actionable ones into a
single sequenced plan:

- **Prompt-injection restructuring** (Phase 1): make the volatile-injection
  machinery explicit and correctly placed — datetime becomes a runtime toggle
  instead of an editable prompt section, the current turn is split into separate
  content blocks (user words + a tagged volatile tail) instead of one
  concatenated string, all volatile tail pieces get semantic XML tags, the
  (static) opt-out hint moves into the cached system prefix, and the
  webhook/trigger context-prompt placement is reviewed.
- **Cache-accounting validation** (Phase 2): prove, against live providers, that
  our cache-token accounting (`inputTokenDetails` read from `totalUsage`) is
  correct across the full matrix, and fix it if not.
- **Multi-step caching** (Phase 3): adopt the AI SDK v6 `prepareStep` pattern so
  the agentic loop caches incrementally *within* a turn (today steps 2..N re-pay
  accumulated tool results at full price on Anthropic/Bedrock).
- **Doc & comment correction** (Phase 4): reconcile in-code comments and the
  CLAUDE.md "Prompt caching" section with what Phases 2–3 verify.

### Non-goals (explicitly out of scope)

- **Cross-user `global` cache scope** — a first-party-Anthropic-only feature; not
  available on the API/Bedrock/OpenAI surfaces we use.
- **Freezing datetime per conversation** (Claude Code style) — rejected: Polyant
  conversations can span days (WhatsApp), so a frozen timestamp would report the
  wrong day. Fresh per-turn datetime in the uncached tail is correct for us.
- **Nebius cache pricing multiplier** — deferred unless Phase 2 shows Nebius
  reports cache tokens (currently priced at the conservative 1× default).
- **Editing the number of prompt sections beyond removing `08-datetime`** — the
  1..7 sections stay as-is.

## 2. Phase 1 — Volatile-injection restructuring

All three sub-items touch the same assembly path
(`agents/supervisor/prompt.ts` + `agents/supervisor/index.ts:buildUserContent`),
so they ship together. They are behaviour-preserving except where noted, and
change the exact prompt bytes → a **one-shot cache invalidation on deploy**
(accepted).

### 2a. datetime → per-instance flag + minimal tag; remove editable section `08-datetime`

**Behaviour today:** `08-datetime` is a DB-editable prompt section, templated with
`{{datetime}}`/`{{timezone}}` and rendered into the per-turn tail
(`prompt.ts:311-315`). De-facto disable = blank the section.

**Target:** datetime injection becomes a per-instance boolean flag; the section
is removed entirely. When the flag is on, the tail carries only:

```
<current_datetime>{datetime} ({timezone})</current_datetime>
```

No prose (i18n-safe — the value carries the meaning; the surrounding sentence is
irrelevant once bracketed). The `datetime` value is still computed per turn via
`new Date().toLocaleString(config.datetime.locale, { timeZone, dateStyle:"full",
timeStyle:"short" })`, only when the flag is on.

**New flag** `datetimeInjectionEnabled` (DB `datetime_injection_enabled`), default
`true`. It mirrors the end-to-end threading of the existing
`stateInPromptEnabled` flag.

**Migration (next number, ~0064) — order is load-bearing:**

1. `ALTER TABLE instances ADD COLUMN datetime_injection_enabled boolean NOT NULL DEFAULT true;`
2. **Backfill conditional on content** (decision: preserve per-instance
   behaviour): set the flag to the result of "does a non-empty `08-datetime` row
   exist for this instance?" — so an instance that had blanked the section stays
   OFF:
   ```sql
   UPDATE instances i SET datetime_injection_enabled = EXISTS (
     SELECT 1 FROM instance_prompts p
     WHERE p.instance_id = i.id
       AND p.section_key = '08-datetime'
       AND btrim(p.content) <> ''
   );
   ```
3. **Then** `DELETE FROM instance_prompts WHERE section_key = '08-datetime';`

(Compute the flag from the rows *before* deleting them.)

**Section-08 removal surface (every site, mapped):**

| File | Change |
|---|---|
| `agents/supervisor/prompt.ts:311` | remove `s08` template block; add flag-gated `<current_datetime>` push to `turnSections` |
| `instances/defaults.ts:134` | remove the `08-datetime` `DEFAULT_PROMPTS` entry |
| `server/instances/instance-prompts.controller.ts:9-18` | remove `"08-datetime"` from the `PromptSectionKeys` enum |
| `server/instances/instance-prompts.controller.ts:29` | `.max(8)` → `.max(7)` |
| `web/.../instances/[slug]/prompts-tab.tsx:32` | remove the dead `"08-datetime": Clock` icon-map entry (sections render dynamically from the API; no other web change, but grep the file for a hardcoded "8") |
| `instances/import.service.ts` (prompt upsert, ~:333) | **anti-resurrection filter**: drop any `08-datetime` entry from incoming bundles, on both import-new and import-overwrite, so an old bundle can't recreate the section |
| migration (~0064) | backfill (2) then delete (3) |
| `agents/supervisor/prompt.test.ts:20,241` | remove `08-datetime` fixtures; add flag-driven tests |
| `CLAUDE.md` | "Prompts (8 sections)" → 7; document the new flag |

The prompt `.md` "report" (`instance-prompts.controller.ts` GET/PATCH,
`filename: {sectionKey}.md`) needs no dedicated change: once `08-datetime` is out
of the enum and the rows are deleted, it no longer appears.

**New-flag surface (clone of `stateInPromptEnabled`):**

- `instances/schema.ts` — Drizzle column `datetimeInjectionEnabled` (default true)
- `instances/config-resolver.ts` — interface field + default + row mapping (×3 sites)
- `instances/store.ts` — store interface + update-input type + the updatable-keys array (`:200`)
- `server/instances/instances.controller.ts` — GET response field (`:80`) + PATCH body type (`:236`)
- `instances/export.service.ts` — add to the exported bundle
- `instances/export.schema.ts` — `datetimeInjectionEnabled: z.boolean().default(true)`; bump bundle version `1.1` → `1.2` (importer keeps accepting `1.0`/`1.1`/`1.2`; the defaulted field means legacy bundles import as enabled = preserve behaviour)
- `instances/import.service.ts` — apply on import-new and import-overwrite (×2)
- `agents/supervisor/index.ts` — `SupervisorInput.datetimeInjectionEnabled` + pass into `buildSupervisorSystemPrompt` options
- `agents/supervisor/prompt.ts` — `PromptOptions.datetimeInjectionEnabled` + gate the datetime tail section
- `pipeline.ts:342`, `index.ts:274,418`, `room/room-engine.ts:172`, `webhooks/webhook-engine.ts:190` — thread the flag from `instanceConfig` into the supervisor input (mirror the `stateInPrompt` threading; Room/webhook conversations still want current time)
- web — `settings-tab.tsx` (state + dirty-check + save payload + toggle), `lib/api-types.ts`, `lib/api.ts`, i18n `en.json`/`it.json` (label + help)

### 2b. Separate content blocks + semantic XML tags on the volatile tail

Today `buildUserContent` (`supervisor/index.ts:391`) concatenates the volatile
context and the user's words into **one text string**:
`<context>\n{turnContext}\n</context>\n\n{message}`. Two problems: the model
can't cleanly tell where system-injected context ends and the user's words
begin, and you can't place a cache breakpoint between them.

Target — restructure the current user turn into **separate content blocks**,
user words first, volatile tail last (the reflection's "Strategy A"):

```
content: [
  { type: "text", text: "<user words>" },              // stable → gets the breakpoint (Phase 3)
  { type: "text", text: "<current_datetime>…</current_datetime>\n<conversation_state>…</conversation_state>…" }  // volatile → NO breakpoint
  … attachments …
]
```

Per-piece semantic tags replace the `##` Markdown headers:

| Piece | Tag |
|---|---|
| datetime (2a) | `<current_datetime>` |
| channel identity (`renderChannelIdentitySection`) | `<channel_identity>` |
| conversation summary | `<conversation_summary>` (keep the "prefer current tool results" note inside) |
| conversation state (`renderConversationStateSection`) | `<conversation_state>` |

Rationale for user-words-first: the volatile block must sit **after** the last
cache breakpoint (the golden rule). Putting the user's words in their own block
before the volatile tail lets Phase 3 mark the user-words block while leaving the
volatile uncached. The reversed reading order (words, then tagged metadata) is
the approved design — the tags disambiguate system-injected context from the
user's words, so ordering does not hurt comprehension.

Add **one sentence to the system prompt** (section `01-identity` or a shared
note) telling the model that `<…>`-tagged context blocks are system-injected,
authoritative metadata — not the user's words. This mirrors Claude Code's
practice of documenting its injected `<system-reminder>`/`<env>` tags.

Note on bloat: the volatile tail is **not** persisted (we persist raw user
words only — `pipeline.ts:432`), so old datetime/state snapshots never accumulate
in history. The reflection's "snapshot accumulation" caveat does not apply to us.

Single text string is preserved as the fast path when there is no volatile tail
(backward compatible).

### 2c. Opt-out hint → static system prefix

`renderOptoutHintSection` moves from `turnSections` to `systemSections` in
`prompt.ts`, appended after section 7 and before any per-conversation
`contextPrompt`. It stays Markdown (`## Messaging opt-out`, consistent with the
other system sections). Rationale: the stop/resume keywords are instance-static,
so this places them in the cached prefix (read at ~0.1× instead of full every
turn) **without** breaking cross-conversation cache sharing (they are identical
across all conversations of the instance).

### 2d. Webhook/trigger context-prompt caching (review + decision)

How it works today (`webhooks/webhook-engine.ts:triggerConversation`): the
per-event `contextPrompt` is `renderTemplate`d from the webhook payload (unique
per event, ≤50KB), then on the trigger turn passed to `supervise({contextPrompt})`
→ appended to the **tail of the `system` block** (`prompt.ts:321`). It is also
persisted as a `role:"system"` history message (`webhook-engine.ts:114`) and the
`contextPrompt` column is cleared afterward, so subsequent inbound turns pick it
up from history (via `foldSystemMessages`) instead.

Caching finding:
- **Trigger turn:** because the unique per-event `contextPrompt` sits at the tail
  of the cached system block under the single system breakpoint, sections 1–7 +
  tools cannot get a cross-trigger cache hit — the unique tail poisons the whole
  system prefix. Within a single (multi-step) trigger turn caching still works:
  the system block is byte-stable across the turn's steps, so breakpoint #1 read-
  hits on steps 2..N.
- **Impact: LOW.** Internal-mode conversations are fresh/one-shot (cold cache
  anyway); channel-mode repeated triggers are usually spaced beyond the 5m TTL;
  the expensive within-turn multi-step caching already works.
- **Inbound turns after a channel-mode trigger:** `contextPrompt` comes from the
  folded history system message — stable within the conversation → cacheable. ✅
- We already avoid snapshot bloat (volatile tail not persisted — see 2b).

Decision: **document the behaviour; defer the optimization.** The only lever —
giving sections 1–7 their own breakpoint *before* the per-event contextPrompt (or
moving the contextPrompt out of `system` into the trigger turn's tail, since it is
really per-turn instructions, not stable system content) — has marginal benefit
and consumes a breakpoint slot. Revisit only if telemetry shows frequent
sub-5-minute repeated triggers to the same instance. The misleading comment
("contextPrompt is stable within a conversation, so it stays in system" —
`prompt.ts:318`, CLAUDE.md) is true for inbound turns but not for the trigger
turn; correct it in Phase 4.

### 2e. Cache TTL → 1 hour

Switch the ephemeral cache TTL from the 5-minute default to **1 hour**. Rationale:
Polyant's production traffic is dominated by slow async channels
(WhatsApp/Telegram) where turns arrive minutes-to-sub-hour apart. With the 5m TTL
the cached prefix expires between turns, so every turn re-pays the write premium
(1.25×) and never collects a read — a net loss versus no cache. The 1h TTL keeps
the prefix warm across those gaps so the large, stable system prefix reads at
~0.1×.

- **Anthropic** (`providers/anthropic.ts`): `cacheControl: { type: "ephemeral", ttl: "1h" }`.
  Ship in Phase 1 (well-documented, low risk).
- **Bedrock** (`providers/bedrock.ts`): the `cachePoint` 1h wire shape is not
  confirmed for the AI SDK — keep `{ type: "default" }` (5m) until **Phase 2
  verifies the 1h form live**, then switch.
- **Trade-off accepted:** the write premium doubles (1.25× → 2×), so
  fast/interactive turns (web playground) and single-turn conversations
  (Room/webhook, which create a fresh conversation per cycle) overpay marginally.
  Net-positive given the slow-async-dominant workload.
- **No flip-busting risk:** the TTL is a constant, not a per-turn/per-channel
  switch, so it never changes mid-conversation (which would otherwise bust the
  whole prefix — report §8.5).
- Phase 2 measures the per-channel cache read/write ratio to confirm the win
  empirically (and to decide Bedrock).

### Phase 1 testing

- `prompt.test.ts`: datetime rendered as `<current_datetime>` when the flag is on,
  absent when off; opt-out rendered in `system` (not the tail) when enabled; each
  tail piece wrapped in its tag.
- `instance-prompts.controller` test: enum rejects `08-datetime`; `.max(7)` holds.
- export/import test: `08-datetime` stripped from an incoming bundle;
  `datetimeInjectionEnabled` round-trips; a legacy bundle without the field
  imports as `true`.
- migration test/manual check: conditional backfill sets the flag from prior
  content, then the rows are gone.

## 3. Phase 2 — Cache-accounting validation (full matrix)

Goal: prove, against live providers, that our cache-token accounting is correct —
specifically the open question that `mapUsage` reads `inputTokenDetails.
{cacheReadTokens,cacheWriteTokens}` from **`totalUsage`** (`base.ts:449`/`:484`),
whereas the AI SDK docs describe those fields on `usage`. For multi-step, `usage`
is the last step and `totalUsage` is the cross-step total; if `totalUsage` does
not carry `inputTokenDetails`, we silently under-count cache tokens and
over-report cost.

**Step 1 — diagnostic script** (scratchpad, gated by the provided `.env`). For
each of **Anthropic, Bedrock, OpenAI**, fire and dump the raw `usage` +
`totalUsage` JSON for:
- two sequential calls with a large byte-identical prefix (system > the model's
  minimum cacheable prefix; Sonnet ≥1024, Opus ≥4096) → expect call 1
  `cacheWrite>0, cacheRead=0`; call 2 `cacheRead>0`;
- one multi-step call with a trivial echo tool → check whether cache tokens
  aggregate into `totalUsage` across steps;
- one streaming call → check `totalUsage` on the resolved response.

**Step 2 — fix** `mapUsage`/`base.ts` per the observed ground truth (e.g. if
cache details live only on per-step `usage`, aggregate across steps; if on
`usage` not `totalUsage`, read the right object).

**Step 3 — encode:**
- gated integration test (skipped without keys) asserting the write-then-read
  pattern and non-zero `ChatResponse.usage.{cachedInputTokens,
  cacheCreationInputTokens}` for all three providers;
- unit test using the *verified* SDK shape (not the assumed one).

**Also in Phase 2:**
- Verify the **Bedrock `cachePoint` 1h wire shape** live (gates the Bedrock half
  of §2e — Anthropic 1h ships in Phase 1, Bedrock waits for this).
- Capture the **per-channel cache read/write ratio** from the diagnostic runs so
  the 1h-vs-5m win is confirmed on real cadence (and to catch any channel where
  the write premium is not amortized).

## 4. Phase 3 — Multi-step caching via `prepareStep`

Confirmed via ctx7 that AI SDK v6 supports `prepareStep({ messages, model,
stepNumber, steps })` returning modified `messages`, and the official Vercel
cookbook (`addCacheControlToMessages`) marks the **last** message each step for
Anthropic caching.

**What is and isn't cached today (clarification):** tool *definitions* are already
cached — they precede `system` in wire order, so they sit inside breakpoint #1's
prefix (`prompt-caching.ts` comment confirms this). The gap is the
`tool_use`/`tool_result` blocks accumulated *within* a multi-step turn: because
the breakpoint is placed once up front (not per step), steps 2..N re-send the
accumulated tool results at full input price. (Cross-turn this only matters when
`tool_results_in_history_enabled` is on — the default keeps history text-only, so
prior-turn tool blocks are not replayed at all.)

**Change:** for Anthropic/Bedrock, move the moving breakpoint into a `prepareStep`
callback that re-marks the last message on each step, so the agentic loop caches
incrementally within a turn. Keep breakpoint #1 (the leading system message) set
once — it is the stable, history-churn-independent checkpoint. This **replaces**
the static `length-2` history breakpoint in `injectCacheBreakpoints`
(`prompt-caching.ts`); the system breakpoint stays.

**Integration notes:**
- `prepare()` in `base.ts` still folds inline system messages and installs the
  leading system message + its marker (breakpoint #1).
- The `prepareStep` callback is provider-specific (Anthropic `cacheControl`,
  Bedrock `cachePoint`, gated to cache-capable families) — thread it through
  `createProvider`'s hooks alongside/instead of the current one-shot
  `prepareMessages`.
- Preserve a single-turn guard so a one-turn/one-step conversation does not pay a
  wasted write on the volatile current turn.
- **Marker must target the user-words block, never the volatile tail block.**
  This relies on the Phase 1b restructuring (separate blocks, user words first,
  volatile last): the breakpoint goes on the stable user-words block so the
  volatile tail is never written as a cross-turn cache entry. During the agentic
  loop, once the SDK appends tool messages the last message is a (stable) tool
  result — safe to mark; the volatile-tail concern only applies at step 0 (user
  turn is last), where we mark the user-words block, not the trailing volatile
  block. So Phase 3 depends on Phase 1b landing first.
- Validate the exact wire shape live using the Phase 2 harness before trusting
  the cost dashboard (same caveat class already noted in code comments).

## 5. Phase 4 — Comment & CLAUDE.md review

After Phases 2–3 land, reconcile documentation with verified reality:
- Challenge and correct comments in `providers/prompt-caching.ts`,
  `providers/anthropic.ts`, `providers/bedrock.ts`, `providers/base.ts`
  (`:449`/`:484` on the `totalUsage` semantics), `ai-gateway/config.ts`
  (cache multipliers), and the misleading `contextPrompt` "stable within a
  conversation, so it stays in system" comment in
  `agents/supervisor/prompt.ts:318` (true for inbound turns, not the trigger
  turn — see §2d).
- Update the CLAUDE.md "Prompt caching + cache-aware cost tracking" section: the
  `prepareStep`/mark-last change, the verified `totalUsage` semantics, and the
  breakpoint model; update "Prompts (8 sections)" → 7 and document
  `datetimeInjectionEnabled`.

## 6. Risks & caveats

- **One-shot cache invalidation on deploy** — Phases 1 and 3 change prompt bytes /
  breakpoint placement; the first request after deploy writes the cache fresh.
  Expected, not a regression.
- **`prepareStep` interaction** with the leading-system-message trick must be
  validated live (Phase 2 harness) before Phase 3 is trusted.
- **Model minimum cacheable prefix** — a minimal instance's `system` may fall
  below Opus 4.8's 4096-token floor (heavy tier), silently not caching. Note in
  docs; not fixed here.
- **`totalUsage` semantics** remain assumed until Phase 2 confirms them — that is
  the whole point of Phase 2.

## 7. Sequencing

1. **Phase 1** — independent, shippable immediately.
2. **Phase 2** — needs the `.env` with provider credentials (supplied at this
   phase).
3. **Phase 3** — depends on Phase 2's live validation of the wire shape.
4. **Phase 4** — closes out, depends on 2–3 outcomes.
