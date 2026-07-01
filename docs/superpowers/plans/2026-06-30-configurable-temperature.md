# Configurable Temperature (per-instance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-instance, provider-agnostic sampling `temperature` that is passed to the LLM only when set and only when the model/thinking combination accepts it.

**Architecture:** A nullable `instances.temperature` column flows through `config-resolver` (which gates it to `null` when unsupported), into the supervisor input, onto `ChatRequest.temperature`, and is spread into `generateText`/`streamText` only when defined. The web Settings tab exposes a 0–2 slider, disabled when the model is reasoning or thinking is ON.

**Tech Stack:** TypeScript (ESM), Drizzle ORM, NestJS, Vercel AI SDK v6, Vitest, Next.js/React 19.

## Global Constraints

- ESM only: all relative imports end in `.js`. Named exports only (no default export).
- File naming kebab-case; `process.env` never read directly in app code.
- Drizzle: snake_case DB columns, camelCase TS. Migrations are written by hand (drizzle-kit generate is broken here) AND the `_journal.json` entry MUST be appended manually or the migration silently no-ops.
- Tool/request changes must stay framework-first (domain-agnostic).
- Tests run at `LOG_LEVEL=debug`. Run engine tests with `npm run test:unit -w @polyant/engine`.
- Branch: `feat/configurable-temperature` (already created; the design spec is committed there).

---

### Task 1: Gateway temperature helpers (`clampTemperature`, `temperatureSupported`)

**Files:**
- Modify: `packages/engine/src/ai-gateway/config.ts` (append two exported functions after `isThinkingCapable`)
- Test: `packages/engine/src/ai-gateway/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `clampTemperature(value: number | null | undefined): number | null`
  - `temperatureSupported(provider: string, modelId: string, thinking: boolean): boolean`

- [ ] **Step 1: Write the failing tests**

Add to `packages/engine/src/ai-gateway/config.test.ts`:

```ts
import { clampTemperature, temperatureSupported } from "./config.js";

describe("clampTemperature", () => {
  it("passes through null/undefined", () => {
    expect(clampTemperature(null)).toBeNull();
    expect(clampTemperature(undefined)).toBeNull();
  });
  it("returns null for non-finite", () => {
    expect(clampTemperature(NaN)).toBeNull();
    expect(clampTemperature(Infinity)).toBeNull();
  });
  it("keeps in-range values", () => {
    expect(clampTemperature(0)).toBe(0);
    expect(clampTemperature(0.7)).toBe(0.7);
    expect(clampTemperature(2)).toBe(2);
  });
  it("clamps out-of-range values", () => {
    expect(clampTemperature(-1)).toBe(0);
    expect(clampTemperature(5)).toBe(2);
  });
});

describe("temperatureSupported", () => {
  it("returns false when thinking is on, any provider", () => {
    expect(temperatureSupported("openai", "gpt-4o", true)).toBe(false);
    expect(temperatureSupported("anthropic", "claude-sonnet-4-6", true)).toBe(false);
    expect(temperatureSupported("bedrock", "eu.amazon.nova-lite-v1:0", true)).toBe(false);
  });
  it("returns false for OpenAI reasoning models", () => {
    expect(temperatureSupported("openai", "o3", false)).toBe(false);
    expect(temperatureSupported("openai", "gpt-5.4", false)).toBe(false);
  });
  it("returns true for standard chat models", () => {
    expect(temperatureSupported("openai", "gpt-4o", false)).toBe(true);
    expect(temperatureSupported("anthropic", "claude-sonnet-4-6", false)).toBe(true);
    expect(temperatureSupported("bedrock", "qwen.qwen3-32b-v1:0", false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -w @polyant/engine -- config.test`
Expected: FAIL — `clampTemperature`/`temperatureSupported` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `packages/engine/src/ai-gateway/config.ts`:

```ts
/**
 * Clamp a sampling temperature into the valid [0, 2] range. `null`/`undefined`
 * pass through as `null` (meaning "use the provider default"); non-finite
 * inputs are treated as unset.
 */
export function clampTemperature(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(2, Math.max(0, value));
}

/**
 * Whether a (provider, model, thinking) combination accepts a custom
 * temperature. Returns false when thinking is ON (Anthropic requires
 * temperature=1; we generalise to "omit" cross-provider) or when the model is
 * an OpenAI reasoning model (rejects temperature != 1). Mirrors the
 * provider/model pattern logic of isThinkingCapable.
 */
export function temperatureSupported(provider: string, modelId: string, thinking: boolean): boolean {
  if (thinking) return false;
  if (provider === "openai" && /^(o[134]|gpt-5)/.test(modelId)) return false;
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -w @polyant/engine -- config.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/ai-gateway/config.ts packages/engine/src/ai-gateway/config.test.ts
git commit -m "feat(ai-gateway): add clampTemperature + temperatureSupported helpers"
```

---

### Task 2: Thread `temperature` through `ChatRequest` and the providers

**Files:**
- Modify: `packages/engine/src/ai-gateway/types.ts` (add field to `ChatRequest`)
- Modify: `packages/engine/src/ai-gateway/providers/base.ts:290-298` and `:326-334`
- Test: `packages/engine/src/ai-gateway/providers/base.test.ts`

**Interfaces:**
- Consumes: `ChatRequest` from Task implicit (existing type).
- Produces: `ChatRequest.temperature?: number` — read by `base.ts` and (later) set by the supervisor.

- [ ] **Step 1: Write the failing test**

Inspect `base.test.ts` for how `tracedGenerateText` is mocked (it asserts on the args object passed to `generateText`). Add a test that asserts the conditional spread. Pattern (adapt to the file's existing mock harness — find the existing `chat()` happy-path test and mirror its setup):

```ts
it("passes temperature to generateText when set", async () => {
  const adapter = createBaseProvider(/* same args as existing test */);
  await adapter.chat({ ...baseRequest, temperature: 0.3 }, "gpt-4o");
  expect(generateTextSpy.mock.calls[0][0]).toMatchObject({ temperature: 0.3 });
});

it("omits temperature from generateText when unset", async () => {
  const adapter = createBaseProvider(/* same args */);
  await adapter.chat({ ...baseRequest }, "gpt-4o");
  expect(generateTextSpy.mock.calls[0][0]).not.toHaveProperty("temperature");
});
```

(`baseRequest`, `generateTextSpy`, and `createBaseProvider` mirror the names already used in `base.test.ts`; reuse the existing fixtures rather than inventing new ones.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- base.test`
Expected: FAIL — `temperature` is not forwarded (the "passes" test fails; the "omits" test passes trivially).

- [ ] **Step 3: Add the type field**

In `packages/engine/src/ai-gateway/types.ts`, inside `interface ChatRequest`, after `thinking?: boolean;`:

```ts
  /** Sampling temperature in [0, 2]. Omitted from the provider call when undefined. */
  temperature?: number;
```

- [ ] **Step 4: Forward it in both provider calls**

In `packages/engine/src/ai-gateway/providers/base.ts`, in `chat()` add the conditional spread alongside the existing `providerOptions` spread (after line 297):

```ts
        ...(request.providerOptions ? { providerOptions: request.providerOptions as Record<string, Record<string, never>> } : {}),
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
```

Apply the identical spread in `chatStream()` after line 333.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- base.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/ai-gateway/types.ts packages/engine/src/ai-gateway/providers/base.ts packages/engine/src/ai-gateway/providers/base.test.ts
git commit -m "feat(ai-gateway): forward ChatRequest.temperature to generateText/streamText"
```

---

### Task 3: DB schema + migration for `instances.temperature`

**Files:**
- Modify: `packages/engine/src/instances/schema.ts` (add column; ensure `real` is imported)
- Modify: `packages/engine/src/instances/store.ts` (add `temperature` to `Instance` interface + `UpdatableInstanceFields` + `UPDATABLE_INSTANCE_KEYS`)
- Create: `packages/engine/src/database/migrations/0059_add_instance_temperature.sql`
- Modify: `packages/engine/src/database/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `Instance.temperature: number | null`; the column is updatable via `updateInstance`.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `packages/engine/src/instances/schema.ts`, add `real` to the import on line 3:

```ts
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, integer, real } from "drizzle-orm/pg-core";
```

Add the column near `thinkingEnabled` (after line 19):

```ts
  temperature: real("temperature"), // nullable; null = use the provider default
```

- [ ] **Step 2: Write the migration SQL**

Create `packages/engine/src/database/migrations/0059_add_instance_temperature.sql`:

```sql
ALTER TABLE "instances" ADD COLUMN "temperature" real;
```

- [ ] **Step 3: Append the journal entry**

In `packages/engine/src/database/migrations/meta/_journal.json`, append after the `idx: 54` entry (inside the `entries` array):

```json
    ,{
      "idx": 55,
      "version": "7",
      "when": 1780444900000,
      "tag": "0059_add_instance_temperature",
      "breakpoints": true
    }
```

(Place the leading comma correctly so the array stays valid JSON — the previous last entry must be followed by `,`.)

- [ ] **Step 4: Extend the `Instance` type and updatable whitelist**

In `packages/engine/src/instances/store.ts`:
- Add to `interface Instance` (after `thinkingEnabled: boolean;` ~line 39):

```ts
  /** Sampling temperature [0, 2]; null = provider default. Gated at runtime by temperatureSupported. */
  temperature: number | null;
```

- Add to `type UpdatableInstanceFields` (after its `thinkingEnabled?: boolean;` ~line 171):

```ts
  temperature?: number | null;
```

- Add `"temperature"` to the `UPDATABLE_INSTANCE_KEYS` array (after `"thinkingEnabled"`).

`toInstance` spreads the row, so no change is needed there.

- [ ] **Step 5: Apply the migration and typecheck**

Run:
```bash
npm run db:migrate -w @polyant/engine
npm run typecheck -w @polyant/engine
```
Expected: migration applies cleanly; typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/instances/schema.ts packages/engine/src/instances/store.ts packages/engine/src/database/migrations/0059_add_instance_temperature.sql packages/engine/src/database/migrations/meta/_journal.json
git commit -m "feat(instances): add nullable temperature column"
```

---

### Task 4: Resolve + gate `temperature` in `config-resolver`

**Files:**
- Modify: `packages/engine/src/instances/config-resolver.ts`
- Test: `packages/engine/src/instances/config-resolver.test.ts`

**Interfaces:**
- Consumes: `clampTemperature`, `temperatureSupported` (Task 1); `Instance.temperature` (Task 3).
- Produces: `InstanceConfig.temperature: number | null` — gated to `null` when unsupported.

- [ ] **Step 1: Write the failing tests**

In `config-resolver.test.ts`, mirror the existing `thinkingEnabled`-gating tests:

```ts
it("resolves a clamped temperature for a standard model", async () => {
  // arrange an instance with provider "openai", model "gpt-4o", temperature 0.3
  const cfg = await resolveInstanceConfig(slug);
  expect(cfg.temperature).toBe(0.3);
});

it("nulls temperature when the model is reasoning", async () => {
  // provider "openai", model "o3", temperature 0.3
  const cfg = await resolveInstanceConfig(slug);
  expect(cfg.temperature).toBeNull();
});

it("nulls temperature when thinking is enabled", async () => {
  // provider "anthropic", thinking-capable model, thinkingEnabled true, temperature 0.3
  const cfg = await resolveInstanceConfig(slug);
  expect(cfg.temperature).toBeNull();
});
```

(Use the file's existing instance-mock helper — find how the `thinkingEnabled` tests stub `findInstanceBySlug`/`getAllSecretsById` and reuse it, adding a `temperature` field to the stub row.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -w @polyant/engine -- config-resolver.test`
Expected: FAIL — `cfg.temperature` is `undefined`.

- [ ] **Step 3: Implement the resolution**

In `config-resolver.ts`:
- Add to the import on line 8: `import { isThinkingCapable, resolveModel, clampTemperature, temperatureSupported } from "../ai-gateway/config.js";`
- Add `temperature: number | null;` to `interface InstanceConfig` (near `thinkingEnabled`).
- In the unknown-instance fallback object (~line 109), add `temperature: null,`.
- In the resolved `config` object, after the `thinkingEnabled:` block (~line 172), extract the gated thinking value into a local and compute temperature from it. Replace the inline `thinkingEnabled:` with:

```ts
  const resolvedThinkingEnabled =
    instance.thinkingEnabled &&
    isThinkingCapable(
      instance.provider ?? "",
      effectiveModelFor(instance.provider ?? undefined, instance.model ?? undefined) ?? "",
    );
```

(declare it just before `const config: InstanceConfig = {`), then in the object literal:

```ts
    thinkingEnabled: resolvedThinkingEnabled,
    temperature: temperatureSupported(
      instance.provider ?? "",
      effectiveModelFor(instance.provider ?? undefined, instance.model ?? undefined) ?? "",
      resolvedThinkingEnabled,
    )
      ? clampTemperature((instance as { temperature?: number | null }).temperature)
      : null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -w @polyant/engine -- config-resolver.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/instances/config-resolver.ts packages/engine/src/instances/config-resolver.test.ts
git commit -m "feat(instances): resolve + gate temperature in config-resolver"
```

---

### Task 5: Propagate `temperature` through the supervisor + pipeline

**Files:**
- Modify: `packages/engine/src/agents/supervisor/index.ts` (`SupervisorInput` + both `chat`/`chatStream` calls at ~640 and ~697)
- Modify: `packages/engine/src/index.ts` (both `supervise`/`superviseStream` input objects at ~261 and ~379)
- Test: `packages/engine/src/agents/supervisor/index.test.ts`

**Interfaces:**
- Consumes: `InstanceConfig.temperature` (Task 4); `ChatRequest.temperature` (Task 2).
- Produces: supervisor forwards `temperature` onto each `ChatRequest`.

- [ ] **Step 1: Write the failing test**

In `index.test.ts`, find the existing test that asserts on the `chat` mock's request arg (the ones checking `provider`/`model`/`thinking`). Add:

```ts
it("forwards temperature to the gateway when provided", async () => {
  await supervise({ ...baseInput, temperature: 0.2 });
  expect(chatMock).toHaveBeenCalledWith(
    expect.objectContaining({ temperature: 0.2 }),
    expect.anything(),
  );
});

it("omits temperature when not provided", async () => {
  await supervise({ ...baseInput });
  expect(chatMock.mock.calls[0][0]).not.toHaveProperty("temperature");
});
```

(Reuse the file's existing `baseInput`/`chatMock` fixtures.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- supervisor/index.test`
Expected: FAIL — `temperature` not in the request.

- [ ] **Step 3: Add the input field**

In `supervisor/index.ts`, in `interface SupervisorInput` after `thinkingEnabled?: boolean;` (~line 66):

```ts
  /** Sampling temperature [0, 2]. Already gated by config-resolver; forwarded verbatim. Omitted when undefined. */
  temperature?: number | null;
```

- [ ] **Step 4: Forward it in both gateway calls**

In `superviseStream` (the `chatStream` call ~line 643) and `supervise` (the `chat` call ~line 700), add after `thinking: input.thinkingEnabled ?? false,`:

```ts
      temperature: input.temperature ?? undefined,
```

- [ ] **Step 5: Pass it from the pipeline**

In `packages/engine/src/index.ts`, in both the `supervise({...})` (~line 261) and `superviseStream({...})` (~line 379) objects, after `thinkingEnabled: ctx.instanceConfig.thinkingEnabled,`:

```ts
        temperature: ctx.instanceConfig.temperature ?? undefined,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:unit -w @polyant/engine -- supervisor/index.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/agents/supervisor/index.ts packages/engine/src/index.ts packages/engine/src/agents/supervisor/index.test.ts
git commit -m "feat(supervisor): propagate temperature to the AI gateway"
```

---

### Task 6: Management API — accept + clamp `temperature` on PATCH, expose on GET

**Files:**
- Modify: `packages/engine/src/server/instances/instances.controller.ts` (PATCH body type ~line 265; GET serialization ~line 82)
- Test: `packages/engine/src/server/instances/instances.controller.test.ts` (if present; otherwise add a focused test file)

**Interfaces:**
- Consumes: `clampTemperature` (Task 1); `updateInstance` accepts `temperature` (Task 3).
- Produces: PATCH `/api/instances/:slug` accepts `temperature: number | null`; GET returns `temperature`.

- [ ] **Step 1: Write the failing test**

In the controller test, add (mirroring an existing PATCH test):

```ts
it("clamps temperature before persisting", async () => {
  await controller.update("acme", { temperature: 5 });
  expect(updateInstanceMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ temperature: 2 }),
  );
});

it("accepts null temperature (clear)", async () => {
  await controller.update("acme", { temperature: null });
  expect(updateInstanceMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ temperature: null }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- instances.controller.test`
Expected: FAIL (or, if no test file exists, create one mirroring the suite's setup and run it).

- [ ] **Step 3: Add to the PATCH body type + clamp**

In `instances.controller.ts`:
- Add `temperature` to the import from `ai-gateway/config.js` (line 43): `import { providerConfigs, isThinkingCapable, clampTemperature } from "../../ai-gateway/config.js";`
- Add to the `@Body()` type (after `thinkingEnabled?: boolean;` ~line 265):

```ts
      temperature?: number | null;
```

- In `update()`, before `let instance = await updateInstance(...)` (~line 315), normalise:

```ts
    if (body.temperature !== undefined) {
      body.temperature = clampTemperature(body.temperature);
    }
```

- [ ] **Step 4: Expose on GET**

In the instance serialization object (~line 82, next to `thinkingEnabled: instance.thinkingEnabled,`):

```ts
        temperature: instance.temperature,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit -w @polyant/engine -- instances.controller.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/server/instances/instances.controller.ts packages/engine/src/server/instances/instances.controller.test.ts
git commit -m "feat(api): accept + clamp temperature on PATCH, expose on GET instance"
```

---

### Task 7: Models endpoint capability hint (`supportsTemperature`)

**Files:**
- Modify: `packages/engine/src/server/instances/instances.controller.ts:165` (models map, where `supportsThinking` is set)
- Test: `packages/engine/src/server/instances/instances.controller.test.ts`

**Interfaces:**
- Consumes: `temperatureSupported` (Task 1).
- Produces: each model entry from `GET /api/instances/models` carries `supportsTemperature: boolean` (computed with `thinking=false`, i.e. the model's intrinsic capability; the UI further ANDs it with the live thinking toggle).

- [ ] **Step 1: Write the failing test**

```ts
it("marks reasoning models as not supporting temperature", async () => {
  const res = await controller.listModels();
  const openai = res.providers.openai.models;
  expect(openai.find((m) => m.id === "o3")?.supportsTemperature).toBe(false);
  expect(openai.find((m) => m.id === "gpt-4o")?.supportsTemperature).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- instances.controller.test`
Expected: FAIL — `supportsTemperature` undefined.

- [ ] **Step 3: Add the import + field**

- Extend the import on line 43 to include `temperatureSupported`.
- In the model-map object that already sets `supportsThinking: isThinkingCapable(name, modelId)` (~line 165):

```ts
        supportsTemperature: temperatureSupported(name, modelId, false),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- instances.controller.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/server/instances/instances.controller.ts packages/engine/src/server/instances/instances.controller.test.ts
git commit -m "feat(api): expose supportsTemperature per model on /models"
```

---

### Task 8: Export/import the `temperature` field

**Files:**
- Modify: `packages/engine/src/instances/export.schema.ts:116` (add field to the instance bundle schema)
- Modify: `packages/engine/src/instances/export.service.ts:116` (read column)
- Modify: `packages/engine/src/instances/import.service.ts:81,197` (apply on import-new AND import-overwrite)
- Test: `packages/engine/src/instances/export.schema.test.ts`

**Interfaces:**
- Consumes: `Instance.temperature` (Task 3).
- Produces: the export bundle includes `temperature`; import re-applies it. Legacy 1.0/1.1 bundles without the field default to `null`.

- [ ] **Step 1: Write the failing test**

In `export.schema.test.ts`, add a case asserting a bundle WITHOUT `temperature` still parses and defaults to `null`, and one WITH `temperature: 0.4` round-trips:

```ts
it("defaults temperature to null for legacy bundles", () => {
  const parsed = exportInstanceSchema.parse({ ...legacyInstanceFixture });
  expect(parsed.temperature).toBeNull();
});
it("preserves temperature when present", () => {
  const parsed = exportInstanceSchema.parse({ ...legacyInstanceFixture, temperature: 0.4 });
  expect(parsed.temperature).toBe(0.4);
});
```

(`legacyInstanceFixture` mirrors the fixture the existing schema tests already use; if none, build a minimal valid instance object from the schema's required fields.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- export.schema.test`
Expected: FAIL — `temperature` not in the parsed object.

- [ ] **Step 3: Add to the schema**

In `export.schema.ts`, next to `thinkingEnabled: z.boolean().default(false),` (line 116):

```ts
  temperature: z.number().nullable().default(null),
```

- [ ] **Step 4: Export the column**

In `export.service.ts`, next to `thinkingEnabled: instance.thinkingEnabled,` (line 116):

```ts
    temperature: instance.temperature,
```

- [ ] **Step 5: Apply on import (both paths)**

In `import.service.ts`, in BOTH the import-new (~line 81) and import-overwrite (~line 197) value objects, next to `thinkingEnabled: data.thinkingEnabled,`:

```ts
        temperature: data.temperature,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:unit -w @polyant/engine -- export.schema.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/instances/export.schema.ts packages/engine/src/instances/export.service.ts packages/engine/src/instances/import.service.ts packages/engine/src/instances/export.schema.test.ts
git commit -m "feat(instances): export/import temperature in the instance bundle"
```

---

### Task 9: Web Settings tab — temperature slider with capability gating

**Files:**
- Modify: `packages/web/src/lib/api-types.ts` (add `temperature` to the instance type ~line 219; add `supportsTemperature` to the model type ~line 310)
- Modify: `packages/web/src/lib/api.ts:524` (PATCH body type — add `temperature?: number | null`)
- Modify: `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx`
- Test: `packages/web/src/app/(admin)/instances/[slug]/settings-tab.test.tsx`

**Interfaces:**
- Consumes: GET instance `temperature`; `/models` `supportsTemperature` (Task 7); PATCH accepts `temperature` (Task 6).
- Produces: a 0–2 slider + numeric input, disabled when not supported; sends `temperature` (or `null` when cleared) in the PATCH.

- [ ] **Step 1: Write the failing test**

In `settings-tab.test.tsx`, mirror the thinking-toggle tests:

```ts
it("disables the temperature control for reasoning models", () => {
  // render with model "o3" (supportsTemperature: false in the mocked /models response)
  render(<SettingsTab instance={{ ...instance, model: "o3" }} />);
  expect(screen.getByLabelText(/temperature/i)).toBeDisabled();
});

it("includes temperature in the save payload", async () => {
  render(<SettingsTab instance={{ ...instance, model: "gpt-4o" }} />);
  // move the slider / set the input to 0.5, click Save
  expect(updateSpy).toHaveBeenCalledWith(
    instance.slug,
    expect.objectContaining({ temperature: 0.5 }),
  );
});
```

(Reuse the suite's existing `render`, `instance` fixture, mocked `api.models.list`, and `updateSpy` for `api.instances.update`. Add `supportsTemperature` to the mocked models response.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @polyant/web -- settings-tab`
Expected: FAIL — no temperature control rendered.

- [ ] **Step 3: Add the types**

- In `api-types.ts`, add `temperature: number | null;` to the instance shape (~line 219) and `supportsTemperature: boolean;` to the model shape (~line 310).
- In `api.ts`, add `temperature?: number | null;` to the PATCH body type (~line 524).

- [ ] **Step 4: Add state + capability + dirty tracking + payload**

In `settings-tab.tsx`:
- State (near `thinkingEnabled`, ~line 110):

```ts
  const [temperature, setTemperature] = useState<number | null>(instance.temperature ?? null);
```

- Capability (near `canEnableThinking`, ~line 212):

```ts
  const canSetTemperature = !!selectedModelInfo?.supportsTemperature && !thinkingEnabled;
```

- Dirty tracking (in the `isDirty` chain, ~line 224):

```ts
    temperature !== (instance.temperature ?? null) ||
```

- Payload (in the save object, near `thinkingEnabled,` ~line 270):

```ts
        temperature: canSetTemperature ? temperature : null,
```

- [ ] **Step 5: Render the control**

Near the thinking toggle block (~line 477), add a control that is disabled when `!canSetTemperature`. Use the existing shadcn `Slider` if present (check `components/ui`); otherwise a numeric `Input` with `type="number" min={0} max={2} step={0.1}`. Render an empty/placeholder state for `null`:

```tsx
<div className="space-y-2">
  <Label htmlFor="temperature">{t("settings.temperature.label")}</Label>
  <Input
    id="temperature"
    type="number"
    min={0}
    max={2}
    step={0.1}
    disabled={!canSetTemperature}
    value={temperature ?? ""}
    placeholder={t("settings.temperature.placeholder")}
    onChange={(e) =>
      setTemperature(e.target.value === "" ? null : Number(e.target.value))
    }
  />
  {!canSetTemperature && (
    <p className="text-xs text-muted-foreground">{t("settings.temperature.unsupportedHint")}</p>
  )}
</div>
```

Add the three i18n keys (`settings.temperature.label`, `.placeholder`, `.unsupportedHint`) to both `lib/i18n` locale files (Italian + English), matching the keys' existing structure for the thinking section.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w @polyant/web -- settings-tab`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/lib/api-types.ts packages/web/src/lib/api.ts "packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx" "packages/web/src/app/(admin)/instances/[slug]/settings-tab.test.tsx" packages/web/src/lib/i18n
git commit -m "feat(web): add temperature slider to instance Settings tab"
```

---

### Task 10: Full verification (typecheck, lint, strict-mode, full test)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck both packages**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS (warnings tolerated per repo state; no new errors).

- [ ] **Step 3: Run the engine + web test suites**

Run:
```bash
npm run test:unit -w @polyant/engine
npm test -w @polyant/web
```
Expected: PASS. The tool `strict-mode.test.ts` is unaffected (no tool schema changed) but must stay green.

- [ ] **Step 4: Final commit (if any incidental fixes were needed)**

```bash
git add -A
git commit -m "chore(temperature): verification fixes"
```

(Skip if nothing changed.)

---

## Self-Review

**Spec coverage:**
- Schema/migration → Task 3 ✓
- `clampTemperature` + `temperatureSupported` → Task 1 ✓
- Resolver gate → Task 4 ✓
- `ChatRequest` + provider pass-through → Task 2 ✓
- Supervisor + pipeline wiring → Task 5 ✓
- Web Settings slider + disabled-with-hint → Task 9 (capability hint from Task 7) ✓
- PATCH accepts + clamps; GET exposes → Task 6 ✓
- Export/import → Task 8 ✓
- Tests for all helpers/gate/pass-through → Tasks 1,2,4,5,6,7,8,9 ✓

**Placeholder scan:** No TBD/TODO; every code step shows the code. Frontend control reuses existing shadcn primitives (with a documented fallback) rather than a vague "add a slider".

**Type consistency:** `temperature: number | null` is used uniformly across `Instance`, `InstanceConfig`, export schema, and web types. `ChatRequest.temperature?: number` and `SupervisorInput.temperature?: number | null` deliberately differ (request omits when undefined; the `?? undefined` coercion at the supervisor bridges `null → undefined`). `temperatureSupported(provider, modelId, thinking)` and `clampTemperature(value)` signatures match every call site (Tasks 4, 6, 7).
