# Configurable Temperature (per-instance) — Design

**Date:** 2026-06-30
**Status:** Approved (pending spec review)
**Author:** brainstorming session

## Problem

The AI gateway never sets a sampling `temperature`: `generateText`/`streamText`
are called without it (`ai-gateway/providers/base.ts`), so every instance runs
at the provider default. We want a first-class, provider-agnostic way to
configure temperature per instance — consistent with how `provider`, `model`,
and `thinkingEnabled` are already configured.

## Key constraint: temperature is not universally configurable

Temperature interacts with reasoning/thinking and cannot be sent blindly:

| Case | Temperature |
|------|-------------|
| Standard chat models (gpt-4o, claude sonnet **without** thinking, Nova, Qwen, gpt-oss…) | Configurable (OpenAI 0–2, Anthropic 0–1) |
| OpenAI reasoning models (o1/o3/o4, gpt-5 reasoning) | Rejected when `≠ 1` (API error / ignored) |
| Anthropic with **extended thinking ON** | Must be `1` — any other value errors |

So the feature requires a **capability gate** that omits temperature when the
effective model or active thinking makes it incompatible — the same pattern as
the existing `isThinkingCapable` gate in `ai-gateway/config.ts`.

## Decisions (from brainstorming)

1. **Granularity:** a single per-instance value (not per-tier, no per-request
   override). Instances pin a model and predominantly use the `standard` tier,
   so one value covers the real cases. Per-tier / per-request are YAGNI.
2. **Unset behaviour:** when temperature is unset (`null`), the gateway omits
   it entirely → provider default. Zero behaviour change for existing
   instances; the only data change is a nullable column.
3. **Thinking/reasoning interaction:** when thinking is ON **or** the effective
   model is an OpenAI reasoning model, temperature is **ignored** (not sent).
   This is the safe cross-provider choice (covers both the Anthropic
   "must be 1" rule and the OpenAI "rejected" rule with one branch).
4. **Range:** `[0, 2]` with **clamp** (not a validation error). Permissive
   upper bound (OpenAI tops out at 2; Anthropic at 1). Out-of-range values are
   clamped, not rejected.

## Architecture

The change threads a single optional value down the existing pipeline; nothing
new is invented. Flow:

```
instances.temperature (DB, nullable)
  → config-resolver.ts  (resolve + GATE → null if unsupported)
  → supervisor input    (provider/model/thinkingEnabled/…/temperature)
  → ChatRequest.temperature (optional, top-level)
  → base.ts             (passed to generateText/streamText ONLY if defined)
```

### 1. Schema — `instances.schema.ts`

Add a nullable column:

```ts
temperature: real("temperature"), // nullable; null = use provider default
```

Incremental migration `00NN_add_instance_temperature.sql`:

```sql
ALTER TABLE "instances" ADD COLUMN "temperature" real;
```

Append the matching entry to
`packages/engine/src/database/migrations/meta/_journal.json` (manual journal
update is mandatory — a SQL file without a journal entry is silently skipped).

### 2. Validation & gating — `ai-gateway/config.ts`

Two pure, independently-testable helpers:

```ts
/** Clamp a temperature into the valid [0, 2] range; null passes through. */
export function clampTemperature(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  return Math.min(2, Math.max(0, value));
}

/**
 * Whether a (provider, model, thinking) combination accepts a custom
 * temperature. False when thinking is ON (Anthropic requires temp=1) or the
 * model is an OpenAI reasoning model (rejects temp != 1). Mirrors the
 * provider/model pattern logic of isThinkingCapable.
 */
export function temperatureSupported(
  provider: string,
  modelId: string,
  thinking: boolean,
): boolean {
  if (thinking) return false;
  if (provider === "openai" && /^(o[134]|gpt-5)/.test(modelId)) return false;
  return true;
}
```

### 3. Resolver — `config-resolver.ts`

- Add `temperature: number | null` to `InstanceConfig` (and the unknown-instance
  fallback returns `null`).
- Resolve from the column, then apply the gate so a stale DB value never reaches
  an incompatible request:

```ts
temperature: temperatureSupported(
  instance.provider ?? "",
  effectiveModelFor(instance.provider ?? undefined, instance.model ?? undefined) ?? "",
  resolvedThinkingEnabled,
)
  ? clampTemperature(instance.temperature)
  : null,
```

(`resolvedThinkingEnabled` is the already-gated `thinkingEnabled` computed just
above in the same resolver.)

### 4. ChatRequest & provider — `types.ts`, `providers/base.ts`

- Add to `ChatRequest`:

```ts
/** Sampling temperature. Omitted from the provider call when undefined. */
temperature?: number;
```

- In both `chat()` and `chatStream()` in `base.ts`, add the conditional
  spread next to the existing ones:

```ts
...(request.temperature != null ? { temperature: request.temperature } : {}),
```

When undefined, the call is byte-for-byte what it is today → no regression.

### 5. Supervisor — `supervisor/index.ts`

- Add `temperature?: number | null` to the supervisor input type.
- Propagate into both `ChatRequest` constructions (≈ lines 640 and 697),
  alongside `provider`/`model`/`thinking`:

```ts
temperature: input.temperature ?? undefined,
```

The wiring that builds the supervisor input from `InstanceConfig` passes
`config.temperature` through.

### 6. Web — Settings tab (`packages/web`)

- Numeric input + slider (range 0–2, step 0.1) in the Settings tab, with a
  placeholder ("Default del provider" / "Provider default") when empty.
- **Disabled with a hint** when the selected model is reasoning or thinking is
  ON. Capability is surfaced via `GET /api/instances/models` (add a
  `temperatureSupported` boolean per the selected provider/model/thinking,
  mirroring the existing thinking-capability hint).
- `PATCH /api/instances/:slug` accepts `temperature` (number or null) — clamp
  server-side via `clampTemperature` before persisting.

### 7. Export/import — `export.schema.ts` / `export.service.ts` / `import.service.ts`

- Add `temperature` to the instance bundle. In the Zod schema use
  `.nullable().default(null)` so legacy 1.0/1.1 bundles still validate (no
  version bump strictly required; the field defaults when absent).
- Export reads the column; import-new and import-overwrite both apply it
  (it is not embedder-related, so it is safe on overwrite, unlike
  `embeddingProvider`).

## Testing

- **Unit — `clampTemperature`:** null/undefined pass-through, in-range identity,
  below-0 → 0, above-2 → 2, non-finite → null.
- **Unit — `temperatureSupported`:** thinking ON → false (any provider);
  openai reasoning (`o3`, `gpt-5*`) → false; openai `gpt-4o` → true;
  anthropic non-thinking → true; bedrock → true.
- **Unit — resolver gate:** stale `temperature` in DB + reasoning model → `null`;
  + thinking ON → `null`; + standard model → clamped value.
- **Unit — `base.ts` pass-through:** `temperature` defined → present in the
  generateText/streamText args; undefined → absent (assert the key is not set).
- **Existing tests:** supervisor request-construction tests updated to assert
  temperature is threaded when present and omitted when absent.

## Out of scope

- Per-tier temperature maps.
- Per-request / per-API-call temperature override.
- Other sampling params (top_p, top_k, frequency/presence penalty) — the same
  pattern could extend to them later, but this spec is temperature-only.
- Changing the Anthropic-thinking behaviour to force `temperature=1` instead of
  omitting (we omit for simplicity and cross-provider uniformity).
