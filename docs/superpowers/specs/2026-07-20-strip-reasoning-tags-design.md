# Strip leaked reasoning tags from user-facing content

**Date:** 2026-07-20
**Status:** Approved

## Problem

An assistant reply delivered on WhatsApp showed raw markup the model had leaked
into its text output, e.g.:

```
… A che ora ti è più comodo? (es. 11, 15:30, ecc.)<reasoning>Now wait for hour
then validate.</reasoning>Perfetto, Flavio! …
```

Two distinct failure modes were mixed in that one message:

1. **Reasoning leaked inline** — the model emitted its chain-of-thought as a
   `<reasoning>…</reasoning>` block inside the reply `content` (rather than in
   the structured `reasoning` field). This is a *model-behaviour* failure that
   ANY instance can trigger, independent of prompt quality.
2. **An unfilled prompt placeholder** (`<callbackWindow>`) and a **duplicated
   message**. These are *instance-specific prompt-authoring* issues, owned by
   whoever writes that instance's prompt.

The tags were visible on WhatsApp (plain-text channel) but invisible in the
admin conversation view, because the admin renders `content` through
`react-markdown` + `rehype-sanitize`, which drops unrecognised raw-HTML tag
nodes while keeping their text children. Same stored string, two renderers.

## Scope

This framework change addresses **only failure mode 1** — the generic,
model-driven reasoning leak. `<callbackWindow>` and message duplication are out
of scope by design: they belong to the instance prompt, not the framework
(framework-first principle — code stays domain-agnostic).

## Design

A pure helper `stripReasoningTags(text: string): string` that removes
chain-of-thought markup the model sometimes leaks into the reply text:

1. **Paired blocks** `<tag>…</tag>` removed **entirely, inner text included**,
   for `tag ∈ {think, thinking, reasoning}` — case-insensitive,
   attribute-tolerant (`<think foo="bar">`), non-greedy, multiline.
2. **Orphan tokens** — any remaining standalone `<think>` / `</reasoning>` etc.
   of those same tags are removed, leaving the surrounding text.
3. **Normalisation** — collapse the whitespace left behind (double spaces) and
   trim.

The tag set is a **closed allowlist** of three names. We do NOT strip arbitrary
`<...>` tokens, so legitimate content is never corrupted (code snippets like
`Array<string>`, comparisons like `x < 5`, or HTML the user explicitly asked
for). The three chosen names do not occur as literal tags in normal assistant
prose.

### Placement

Both the non-streaming (`chat`) and streaming (`chatStream`) provider paths
funnel their final text through the single `buildChatResponse()` function in
`packages/engine/src/ai-gateway/providers/base.ts`. The helper is applied
**once**, at the top of `buildChatResponse`, on the incoming `text` parameter.
This is provider-agnostic and sits upstream of persistence and every channel —
no channel adapter is touched, and future channels inherit the cleaning for
free.

### Deliberate non-goals

- **`steps[].text` is left raw.** Only the top-level user-facing `text` is
  cleaned. The per-step debug trail (admin "detailed" view, LangSmith) keeps
  what the model actually emitted, so leaks remain diagnosable — "we'd still
  notice nonsensical or incomplete messages" stays true.
- **The live stream (`fullStream`) is not touched.** Real async channels
  (WhatsApp/Telegram) deliver only the final buffered text, which is cleaned.
  The playground/OpenAI-compat SSE may briefly flash a tag mid-stream while
  typing, but the persisted turn is clean. Acceptable for a dev surface.
- **Hook-authored replies** (halt/replace) bypass the gateway and are authored
  by trusted code, not the model — out of scope.
- **The OpenAI-compat controller's cosmetic `<think>` wrapping** of tool
  progress (`openai.controller.ts`) is a different layer (HTTP response only,
  never persisted) and is unaffected.

## Testing

One co-located test file `strip-reasoning-tags.test.ts` covering:

- the exact reported string → the `<reasoning>…</reasoning>` block is gone,
  `<callbackWindow>` and the duplication survive (proving scope);
- uppercase tag, tag with attributes;
- orphan (unclosed) opening tag;
- a `<think>`-like word inside a fenced code block is not the target (the three
  names don't appear as literal tags in code, so plain content is preserved);
- idempotency and clean-input passthrough (no change, no extra trimming beyond
  spec).

## Size

One ~15-line pure helper + one call site in `buildChatResponse` + one test file.
No new dependencies, no DB migration, no config, no API change.
