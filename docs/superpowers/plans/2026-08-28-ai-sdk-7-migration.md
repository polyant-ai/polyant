<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# AI SDK 7 migration plan

Status: awaiting approval
Branch: `chore/dependency-majors-2026-08`
Supersedes: PR #254 (stale — pinned `ai@7.0.77`, predates `@ai-sdk/mcp`)

## Why this is not a Dependabot merge

#254 raises six majors at once (`ai` 6→7, `@ai-sdk/openai` 3→4,
`@ai-sdk/anthropic` 3→4, `@ai-sdk/amazon-bedrock` 4→5,
`@ai-sdk/openai-compatible` 2→3) and does not touch `@ai-sdk/mcp`, which
this repo added to develop after the PR was opened and which must move 1→2.
None of the provider packages peer-depend on `ai`, so npm will not catch a
mismatched matrix: it has to be verified by us.

## What the survey found

The raw import count (43 files referencing `ai` or `@ai-sdk/*`) badly
overstates the work. Measured on this branch:

**The entire SDK call surface is one file.** `ai-gateway/providers/base.ts`
holds both calls — `tracedGenerateText` (chat) and `tracedStreamText`
(stream) — reached through the LangSmith wrappers in `ai-gateway/langsmith.ts`.
Everything else uses our own types.

**Most of the scary counts are internal names, not SDK API:**

| Symbol | Raw count | Reality |
|---|---|---|
| `cachedInputTokens` | 36 src | **Our field**, `ai-gateway/types.ts:122,161`. `base.ts:206` already reads `details.cacheReadTokens ?? o.cachedInputTokens` — the v7 shape is *already* absorbed |
| `fullStream` | 23 src | Mostly **our** stream interface (`index.ts` builds objects with this property). Only `base.ts:681` reads it off an SDK result |
| `maxSteps` | 10 src | **Our field**, `ai-gateway/types.ts:29`. Not an SDK option |
| `system:` | 28 src | Mostly our prompt assembly. Only the two `base.ts` call sites pass it to the SDK |
| `providerOptions` | 43 src | Passed through opaquely; shape owned by the provider packages |

**Nothing in the repo uses the removed or renamed extras**: zero occurrences
of `onFinish`, `onStepFinish`, any `experimental_*`, `needsApproval`,
`toUIMessageStreamResponse`, `toTextStreamResponse`, `includeRawChunks`,
`ToolCallOptions`, `customProvider`. `prepareStep` is already the
non-experimental name.

**No external blocker.**

- `@polyant-ai/plugin-sdk@1.5.0` does not depend on `ai` or `@ai-sdk/*` at
  all (only `zod-to-json-schema`), so tools and plugins are unaffected.
- `langsmith@0.7.17`, which wraps the SDK via `wrapAISDK`, already speaks the
  v7 vocabulary: its Vercel wrapper references `instructions` (4),
  `inputTokenDetails` (2), `onEnd` (4) and `.stream` (13), with no
  `fullStream`, and keeps a `totalUsage` fallback. Identical on these markers
  in the latest 0.9.0, so no langsmith bump is required for v7.
- Node: `ai@7` requires `>=22`; we run 22.19.
- Prerequisite: `ai@7` and every provider peer `zod ^3.25.76 || ^4.1.8`. We
  declare `^3.23.0` and happen to resolve 3.25.76. The declared range must be
  raised to `^3.25.76` so the requirement stops being an accident.

## The one real design decision

Today `base.ts` reads `totalUsage` for the cross-step total and treats
`usage` as final-step-only — stated in comments at `:198`, `:644` and `:684`.
**v7 inverts this**: `usage` becomes cumulative across steps, `totalUsage` is
deprecated, and final-step values move to `finalStep.*`. The same inversion
hits top-level `reasoning`, also read in both call paths.

This matters more than a rename because it feeds the cost accounting: the
absolute per-model cache rates and the cached-token split. Getting it
backwards does not throw — it silently mis-bills.

**Chosen approach: absorb it at the existing boundary.** `mapUsage` already
exists in `base.ts` for exactly this purpose and already handles both cached-
token shapes. The inversion is confined to the two `mapUsage` call sites plus
the two `reasoning` reads, and the rest of the engine keeps its internal
`TokenUsage` type untouched.

Rejected: propagating the v7 shape outward into the eight files that mention
`cachedInputTokens`. It would spread an SDK detail across the codebase and
contradict the gateway's whole purpose.

## Steps

Each step ends green (typecheck, lint, full suite) before the next starts.

1. **Raise the zod floor** to `^3.25.76` in `packages/engine/package.json`.
   No resolution change expected (already 3.25.76); makes the v7 peer
   requirement explicit. Verify the tool `strict-mode.test.ts` suite still
   passes, since it inspects every tool's Zod schema.

2. **Write the failing tests for the usage inversion first.** Against the
   current v6 install, add tests to the `ai-gateway` suite pinning that a
   multi-step result reports the *cumulative* token total and that cached-read
   tokens survive, driven through `mapUsage` with both a v6-shaped and a
   v7-shaped result object. The v7-shaped case must fail before the migration
   and pass after — this is the test that would otherwise not exist for the
   silent-mis-billing risk.

3. **Bump the six packages** to `ai@^7.0.83`, `@ai-sdk/openai@^4.0.50`,
   `@ai-sdk/anthropic@^4.0.44`, `@ai-sdk/amazon-bedrock@^5.0.66`,
   `@ai-sdk/openai-compatible@^3.0.39`, `@ai-sdk/mcp@^2.0.39`. Audit-diff
   against the recorded baseline (4 moderate + 4 high) and confirm the
   resolved matrix is internally consistent.

4. **Run the codemod, then review every hunk**: `npx @ai-sdk/codemod v7`.
   It handles mechanical renames; it does not understand the semantic items,
   and it may touch our internal `fullStream`/`system` names where we do not
   want it to. Anything it changes outside `ai-gateway/` and the tests gets
   scrutinised, not trusted.

5. **Hand-migrate `base.ts`**: `system` → `instructions`, `stepCountIs` →
   `isStepCount` (1 import, 2 call sites), the SDK-result `fullStream` →
   `stream`, the `totalUsage`/`usage` inversion at both `mapUsage` sites, the
   two `reasoning` reads to `finalStep`, and correct the now-wrong `v5+`
   comments rather than leaving them to mislead.

6. **Verify the provider-option shapes empirically**, not from the changelog:
   prompt caching (Anthropic and Bedrock cache control), reasoning/thinking
   budgets, and the temperature-under-reasoning rules. These are the areas
   the repo has already been burned on, and the memory note is explicit that
   the SDK silently strips unsupported params, so a passing call proves
   nothing on its own — assertions go against the request actually built.

7. **Confirm `responseBody` on provider errors still populates.**
   `base.ts:504-537` reads it off thrown errors for the debug payload. v7
   excludes request/response bodies from *results* by default; the error path
   is separate, but it is load-bearing for diagnostics and cheap to check.

8. **Full verification** against the baseline table already recorded on this
   branch, plus both builds.

9. **Real smoke test on the ephemeral stack.** This is the step that needs
   something we do not currently have — see below.

## The gap in step 9

The engine's `.env` carries no provider API keys, so unlike undici and
ESLint this bump cannot be smoke-tested without credentials. A real test
needs at least one live provider, and ideally the paths this migration
actually risks:

- one streaming turn and one non-streaming turn, asserting the reply arrives
  and the **cumulative** token usage is reported, not the final step's;
- one multi-step turn with a tool call, which is where the cumulative-usage
  inversion shows up at all;
- one cached turn on Anthropic or Bedrock, asserting cache-read tokens are
  attributed and the cost is computed with the absolute per-model rate;
- one reasoning-enabled turn.

Without a key, steps 1-8 can be completed and verified, but step 9 reduces to
"the stack boots and serves", which does not exercise anything this bump
touches.

## Rollback

Steps 1-2 stand alone and are keepers regardless. Steps 3-7 are a contiguous
group: if the provider-option verification in step 6 fails, the bump is
reverted as a unit and #254 is closed with the finding, the way #196 and #269
were.
