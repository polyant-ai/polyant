# `sensitive` Flag for Tool Config Parameters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tool declare, per config field, whether it is a **secret** (masked in the admin UI, never echoed by the API) or a **readable** value such as a base URL (shown in cleartext, echoed so it can be edited) — by adding a `sensitive` flag to `RequiredSecretSpec`.

**Architecture:** Presentation-only change. The engine `normalizeRequiredSecrets` materializes a `sensitive` default per field type (`text` → `true`, `select` → `false`); the `/tools/required-secrets` endpoint echoes the stored value only for non-sensitive fields; the web Settings tab renders a plain cleartext input for readable fields and the existing masked `SecretField` for secrets. Storage and AES-256-GCM encryption at rest are unchanged — no DB migration.

**Tech Stack:** TypeScript (ESM), NestJS 11, Vitest, Next.js 16 / React 19, Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-12-tool-config-sensitive-flag-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/engine/src/agents/tools/registry.ts` | `RequiredSecretSpec` contract + `normalizeRequiredSecrets` default-fill | Modify |
| `packages/engine/src/agents/tools/registry.test.ts` | Registry unit tests | Modify (update outdated assertions + add cases) |
| `packages/engine/src/server/instances/instance-tools.secrets-view.ts` | **New** pure view-builders for the required-secrets endpoint (dedup/sort + attach readable values) | Create |
| `packages/engine/src/server/instances/instance-tools.secrets-view.test.ts` | Unit tests for the pure view-builders | Create |
| `packages/engine/src/server/instances/instance-tools.controller.ts` | Thin HTTP bridge — delegate to the view-builders | Modify |
| `packages/web/src/lib/api-types.ts` | FE `RequiredSecretSpec` type | Modify (add `sensitive?`) |
| `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx` | Render branch + prefill + `ReadableField` component | Modify |
| `packages/web/src/app/(admin)/instances/[slug]/settings-tab.test.tsx` | **New** FE test for the readable-field render path | Create |
| `packages/engine/src/agents/tools/http-request.tool.ts` | Demo migration: mark `http_allowed_domains` readable | Modify |

**Why a new view file (`instance-tools.secrets-view.ts`)?** The controller currently holds the dedup/echo logic inline (a coding-rule violation — controllers must be thin bridges). Extracting two pure functions makes the logic unit-testable **without** importing the NestJS controller (which pulls in the DB client at module load). The view file imports only the `RequiredSecretSpec` **type** from the registry, so it has zero runtime coupling.

---

## Task 1: Engine — add `sensitive` to `RequiredSecretSpec` + default-fill in `normalizeRequiredSecrets`

**Files:**
- Modify: `packages/engine/src/agents/tools/registry.ts:57-68` (interface), `:126-157` (normalizer)
- Test: `packages/engine/src/agents/tools/registry.test.ts`

- [ ] **Step 1: Update the existing (now-outdated) assertions to expect the `sensitive` field**

These assertions check the **normalized** output of `listAvailableTools` / `normalizeRequiredSecrets`, which will gain a `sensitive` field. This is a TEST OUTDATED change (intentional behavior change), not a regression. Per-tool tests that read the **raw** `def.requiredSecrets` are NOT affected (the normalizer returns a new array and never mutates the stored definition).

In `registry.test.ts`, line 387 (`normalizes legacy string requiredSecrets`):
```ts
expect(entry.requiredSecrets).toEqual([{ key: "legacy_key", type: "text", sensitive: true }]);
```

Lines 402-404 (`passes through rich select specs`):
```ts
expect(entry.requiredSecrets).toEqual([
  { key: "search_provider", type: "select", choices: ["a", "b"], label: "Provider", sensitive: false },
]);
```

Lines 420-423 (`supports mixed legacy + rich specs`):
```ts
expect(entry.requiredSecrets).toEqual([
  { key: "plain_token", type: "text", sensitive: true },
  { key: "provider", type: "select", choices: ["x"], optional: true, sensitive: false },
]);
```

Line 481 (`does not expose create function ... but does expose requiredSecrets`):
```ts
expect(entry.requiredSecrets).toEqual([{ key: "key", type: "text", sensitive: true }]);
```

Lines 499-502 (`converts bare strings into text specs`):
```ts
expect(normalizeRequiredSecrets(["a_key", "b_key"])).toEqual([
  { key: "a_key", type: "text", sensitive: true },
  { key: "b_key", type: "text", sensitive: true },
]);
```

Lines 505-508 (`passes through select specs with non-empty choices`) — replace the `toEqual(input)` self-comparison with the augmented expectation:
```ts
it("passes through select specs with non-empty choices", () => {
  const input = [{ key: "provider", type: "select" as const, choices: ["x", "y"] }];
  expect(normalizeRequiredSecrets(input)).toEqual([
    { key: "provider", type: "select", choices: ["x", "y"], sensitive: false },
  ]);
});
```

- [ ] **Step 2: Add new failing tests for the default-fill and explicit override**

Add inside the `describe("normalizeRequiredSecrets", ...)` block in `registry.test.ts`:
```ts
it("defaults text fields to sensitive: true", () => {
  expect(normalizeRequiredSecrets(["api_key"])).toEqual([
    { key: "api_key", type: "text", sensitive: true },
  ]);
});

it("defaults select fields to sensitive: false", () => {
  expect(
    normalizeRequiredSecrets([{ key: "provider", type: "select", choices: ["a"] }]),
  ).toEqual([{ key: "provider", type: "select", choices: ["a"], sensitive: false }]);
});

it("preserves an explicit sensitive override on either type", () => {
  expect(
    normalizeRequiredSecrets([
      { key: "base_url", type: "text", sensitive: false },
      { key: "token", type: "select", choices: ["a"], sensitive: true },
    ]),
  ).toEqual([
    { key: "base_url", type: "text", sensitive: false },
    { key: "token", type: "select", choices: ["a"], sensitive: true },
  ]);
});
```

- [ ] **Step 3: Run the registry tests and confirm they FAIL**

Run: `npm test -w @polyant/engine -- registry.test`
Expected: FAIL — the new `sensitive` field is missing from the normalizer output (e.g. `defaults text fields to sensitive: true` fails because the actual is `{ key: "api_key", type: "text" }`).

- [ ] **Step 4: Add `sensitive` to the `RequiredSecretSpec` interface**

In `registry.ts`, replace the interface (lines 57-68):
```ts
export interface RequiredSecretSpec {
  key: string;
  type: "text" | "select";
  /** Human-readable label for the admin UI. Defaults to a humanized form of `key`. */
  label?: string;
  /** Optional help text shown under the field in the admin UI. */
  description?: string;
  /** Allowed values when `type === "select"`. Must be non-empty for select fields. */
  choices?: string[];
  /** When true, the field can be left empty without flagging the tool as misconfigured. */
  optional?: boolean;
  /**
   * Whether the value is a credential to be masked (`true`) or a readable config
   * value such as a base URL or an allowlist (`false`). After
   * `normalizeRequiredSecrets`, this is always set: `text` → `true`,
   * `select` → `false`, unless the tool overrides it. `false` fields are shown
   * in cleartext in the admin UI and their stored value is echoed by
   * `/tools/required-secrets`; `true` fields are never echoed. Storage at rest
   * is always encrypted regardless of this flag.
   */
  sensitive?: boolean;
}
```

- [ ] **Step 5: Fill the `sensitive` default in `normalizeRequiredSecrets`**

In `registry.ts`, in the `.map(...)` body of `normalizeRequiredSecrets` (lines 132-156):

Change the string branch return (line 141) from:
```ts
      return { key: entry, type: "text" as const };
```
to:
```ts
      return { key: entry, type: "text" as const, sensitive: true };
```

Change the final spec return (line 155) from:
```ts
    return entry;
```
to:
```ts
    // Default secrecy by type: text → secret (masked), select → readable (a
    // public choice). An explicit `sensitive` on the spec always wins.
    return { ...entry, sensitive: entry.sensitive ?? (entry.type === "select" ? false : true) };
```

- [ ] **Step 6: Run the registry tests and confirm they PASS**

Run: `npm test -w @polyant/engine -- registry.test`
Expected: PASS (all cases, including the updated and new ones).

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/agents/tools/registry.ts packages/engine/src/agents/tools/registry.test.ts
git commit -s -m "feat(tools): add sensitive flag to RequiredSecretSpec with type-based default"
```

---

## Task 2: Engine — pure required-secrets view-builders + thin controller

**Files:**
- Create: `packages/engine/src/server/instances/instance-tools.secrets-view.ts`
- Create test: `packages/engine/src/server/instances/instance-tools.secrets-view.test.ts`
- Modify: `packages/engine/src/server/instances/instance-tools.controller.ts:1-54`

- [ ] **Step 1: Write the failing test for the view-builders**

Create `packages/engine/src/server/instances/instance-tools.secrets-view.test.ts`:
```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  collectEnabledToolSecrets,
  attachReadableValues,
} from "./instance-tools.secrets-view.js";
import type { RequiredSecretSpec } from "../../agents/tools/registry.js";

describe("collectEnabledToolSecrets", () => {
  it("dedupes by key (first-seen wins) and sorts by key", () => {
    const tools = [
      { name: "b", requiredSecrets: [{ key: "z_key", type: "text" as const, sensitive: true }] },
      {
        name: "a",
        requiredSecrets: [
          { key: "a_key", type: "text" as const, sensitive: true },
          { key: "z_key", type: "text" as const, sensitive: false },
        ],
      },
    ];
    const out = collectEnabledToolSecrets(tools, new Set(["a", "b"]));
    expect(out.map((s) => s.key)).toEqual(["a_key", "z_key"]);
    // first-seen wins: z_key kept from tool "b" (sensitive: true)
    expect(out.find((s) => s.key === "z_key")!.sensitive).toBe(true);
  });

  it("treats an empty enabledNames set as all-enabled", () => {
    const tools = [
      { name: "a", requiredSecrets: [{ key: "k", type: "text" as const, sensitive: true }] },
    ];
    expect(collectEnabledToolSecrets(tools, new Set())).toHaveLength(1);
  });

  it("skips disabled tools", () => {
    const tools = [
      { name: "a", requiredSecrets: [{ key: "k", type: "text" as const, sensitive: true }] },
    ];
    expect(collectEnabledToolSecrets(tools, new Set(["other"]))).toEqual([]);
  });

  it("ignores tools without requiredSecrets", () => {
    const tools = [{ name: "a" }];
    expect(collectEnabledToolSecrets(tools, new Set(["a"]))).toEqual([]);
  });
});

describe("attachReadableValues", () => {
  const specs: RequiredSecretSpec[] = [
    { key: "base_url", type: "text", sensitive: false },
    { key: "api_key", type: "text", sensitive: true },
    { key: "provider", type: "select", choices: ["a"], sensitive: false },
  ];

  it("echoes currentValue for non-sensitive fields with a stored value", () => {
    const out = attachReadableValues(specs, {
      base_url: "https://api.example.io",
      api_key: "sk-secret",
      provider: "a",
    });
    expect(out.find((s) => s.key === "base_url")).toMatchObject({
      currentValue: "https://api.example.io",
    });
    expect(out.find((s) => s.key === "provider")).toMatchObject({ currentValue: "a" });
  });

  it("never echoes a value for sensitive fields", () => {
    const out = attachReadableValues(specs, { api_key: "sk-secret" });
    expect(out.find((s) => s.key === "api_key")).not.toHaveProperty("currentValue");
  });

  it("omits currentValue for non-sensitive fields with no stored value", () => {
    const out = attachReadableValues(specs, {});
    expect(out.find((s) => s.key === "base_url")).not.toHaveProperty("currentValue");
  });
});
```

- [ ] **Step 2: Run the test and confirm it FAILS**

Run: `npm test -w @polyant/engine -- instance-tools.secrets-view`
Expected: FAIL — module `./instance-tools.secrets-view.js` does not exist.

- [ ] **Step 3: Create the view-builder module**

Create `packages/engine/src/server/instances/instance-tools.secrets-view.ts`:
```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RequiredSecretSpec } from "../../agents/tools/registry.js";

/** Spec returned to the admin UI: includes `currentValue` for non-sensitive fields. */
export type RequiredSecretSpecWithValue = RequiredSecretSpec & { currentValue?: string };

/** Minimal shape consumed from `listAvailableTools()` — only what this view needs. */
interface ToolWithSecrets {
  name: string;
  requiredSecrets?: RequiredSecretSpec[];
}

/**
 * Pure: collect the deduped, key-sorted secret specs across the instance's
 * enabled tools. First-seen wins on key collisions. An empty `enabledNames`
 * means "all tools enabled" (preserves the original endpoint semantics).
 */
export function collectEnabledToolSecrets(
  allTools: ToolWithSecrets[],
  enabledNames: Set<string>,
): RequiredSecretSpec[] {
  const specsByKey = new Map<string, RequiredSecretSpec>();
  for (const t of allTools) {
    const isEnabled = enabledNames.size === 0 || enabledNames.has(t.name);
    if (isEnabled && t.requiredSecrets) {
      for (const spec of t.requiredSecrets) {
        if (!specsByKey.has(spec.key)) {
          specsByKey.set(spec.key, spec);
        }
      }
    }
  }
  return Array.from(specsByKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Pure: attach `currentValue` (cleartext) to every non-sensitive spec that has
 * a stored value. Sensitive specs never carry a value — this is the readability
 * boundary enforced server-side.
 */
export function attachReadableValues(
  specs: RequiredSecretSpec[],
  currentSecrets: Record<string, string>,
): RequiredSecretSpecWithValue[] {
  return specs.map((spec) => {
    if (spec.sensitive === false) {
      const currentValue = currentSecrets[spec.key];
      return currentValue ? { ...spec, currentValue } : { ...spec };
    }
    return { ...spec };
  });
}
```

- [ ] **Step 4: Run the test and confirm it PASSES**

Run: `npm test -w @polyant/engine -- instance-tools.secrets-view`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Wire the controller to the view-builders**

In `instance-tools.controller.ts`:

Replace the import on line 5:
```ts
import { listAvailableTools } from "../../agents/tools/registry.js";
```
(drops the now-unused `type RequiredSecretSpec` import.)

Add an import after line 7:
```ts
import {
  collectEnabledToolSecrets,
  attachReadableValues,
} from "./instance-tools.secrets-view.js";
```

Delete the local type alias (lines 13-14):
```ts
/** Spec returned to the admin UI: includes `currentValue` for non-sensitive `select` fields. */
type RequiredSecretSpecWithValue = RequiredSecretSpec & { currentValue?: string };
```

Replace the body of `getRequiredSecrets` (lines 19-54) with:
```ts
  async getRequiredSecrets(@Param("slug") slug: string) {
    const instance = await findInstanceOrFail(slug);
    const enabledNames = await getEnabledToolNames(instance.id);
    const specs = collectEnabledToolSecrets(listAvailableTools(), enabledNames);

    // Fetch stored values only when at least one field is readable (non-sensitive);
    // true secrets are never echoed, so there is no reason to load them.
    const hasReadable = specs.some((s) => s.sensitive === false);
    const currentSecrets = hasReadable ? await getAllSecretsById(instance.id) : {};

    return { requiredSecrets: attachReadableValues(specs, currentSecrets) };
  }
```

- [ ] **Step 6: Typecheck the engine and run the broader server + tools suite**

Run: `npm run typecheck -w @polyant/engine`
Expected: no errors (the unused-import removal and the new module both type-clean).

Run: `npm test -w @polyant/engine -- instance-tools registry.test tools-sync http-request.tool web-search.tool supervisor`
Expected: PASS — confirms the controller refactor and the Task 1 default-fill did not break tool registration, sync, or supervisor secret-gating.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/server/instances/instance-tools.secrets-view.ts packages/engine/src/server/instances/instance-tools.secrets-view.test.ts packages/engine/src/server/instances/instance-tools.controller.ts
git commit -s -m "refactor(tools): echo readable (non-sensitive) values from required-secrets endpoint"
```

---

## Task 3: Web — readable-field rendering in the Settings tab

**Files:**
- Modify: `packages/web/src/lib/api-types.ts:117-127`
- Modify: `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx` (`:174-187` prefill, `:693-705` render branch, new `ReadableField` component near `:799`)
- Create test: `packages/web/src/app/(admin)/instances/[slug]/settings-tab.test.tsx`

- [ ] **Step 1: Add `sensitive` to the FE `RequiredSecretSpec` type**

In `api-types.ts`, replace lines 117-127:
```ts
/** Per-instance config field declared by a tool. `text` is an input; `select` renders a dropdown over `choices`. */
export interface RequiredSecretSpec {
  key: string;
  type: "text" | "select";
  label?: string;
  description?: string;
  choices?: string[];
  optional?: boolean;
  /** false → readable value (shown in cleartext, prefilled from `currentValue`); true/undefined → secret (masked input). */
  sensitive?: boolean;
  /** Cleartext value for non-sensitive fields (so the UI can prefill). Never present for sensitive fields. */
  currentValue?: string;
}
```

- [ ] **Step 2: Write the failing FE test**

Create `packages/web/src/app/(admin)/instances/[slug]/settings-tab.test.tsx`:
```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { SettingsTab } from "./settings-tab";
import type { Instance } from "@/lib/api";

const { secretsListMock, modelsListMock, toolsRequiredSecretsMock } = vi.hoisted(() => ({
  secretsListMock: vi.fn(),
  modelsListMock: vi.fn(),
  toolsRequiredSecretsMock: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("./page-actions-context", () => ({
  usePageSaveAction: vi.fn(),
  usePageActions: vi.fn(() => ({ saveAction: null, setSaveAction: vi.fn() })),
  PageActionsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api", () => ({
  api: {
    secrets: { list: (...a: unknown[]) => secretsListMock(...a), set: vi.fn(), delete: vi.fn() },
    models: { list: (...a: unknown[]) => modelsListMock(...a) },
    tools: { requiredSecrets: (...a: unknown[]) => toolsRequiredSecretsMock(...a) },
    instances: { update: vi.fn() },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "test-instance",
    name: "Test Instance",
    description: "A test instance",
    status: "active",
    provider: "openai",
    model: "gpt-4o",
    memoryEnabled: true,
    knowledgeEnabled: false,
    langsmithEnabled: false,
    langsmithProject: null,
    authEnabled: false,
    thinkingEnabled: false,
    stateInPromptEnabled: false,
    toolResultsInHistoryEnabled: false,
    debugEnabled: false,
    optoutEnabled: false,
    optoutStopKeywords: [],
    optoutResumeKeywords: [],
    optoutClosingMessage: null,
    optoutResumeMessage: null,
    optoutInjectPromptHint: false,
    sttProvider: "openai",
    icon: null,
    ...overrides,
  } as Instance;
}

describe("SettingsTab — tool secret rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secretsListMock.mockResolvedValue({ secrets: [] });
    modelsListMock.mockResolvedValue({ providers: { openai: { models: [] } } });
  });

  it("renders a readable (sensitive:false) tool secret as a prefilled cleartext input", async () => {
    toolsRequiredSecretsMock.mockResolvedValue({
      requiredSecrets: [
        {
          key: "service_base_url",
          type: "text",
          sensitive: false,
          label: "Service base URL",
          currentValue: "https://api.example.com",
        },
        { key: "service_api_key", type: "text", sensitive: true, label: "Service API key" },
      ],
    });

    render(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} />);

    // The readable field is prefilled and rendered as a cleartext (type=text) input.
    const readable = await screen.findByDisplayValue("https://api.example.com");
    expect(readable).toHaveAttribute("type", "text");
  });

  it("renders a sensitive tool secret as a masked (password) input with no prefill", async () => {
    toolsRequiredSecretsMock.mockResolvedValue({
      requiredSecrets: [
        { key: "service_api_key", type: "text", sensitive: true, label: "Service API key" },
      ],
    });

    const { container } = render(<SettingsTab instance={makeInstance()} onUpdate={vi.fn()} />);

    await screen.findByText("Service API key");
    // No cleartext prefill exists for a sensitive field.
    expect(screen.queryByDisplayValue("https://api.example.com")).toBeNull();
    // At least one masked input is present for the secret field.
    const masked = Array.from(container.querySelectorAll("input")).filter(
      (i) => i.getAttribute("type") === "password",
    );
    expect(masked.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the FE test and confirm it FAILS**

Run: `npm test -w @polyant/web -- settings-tab`
Expected: FAIL — the readable field is currently rendered by `SecretField` as `type="password"` and is **not** prefilled (prefill only applies to `select`), so `findByDisplayValue("https://api.example.com")` does not find it / it is not `type=text`.

- [ ] **Step 4: Extend the prefill to all fields that carry a `currentValue`**

In `settings-tab.tsx`, in the `useEffect` at lines 174-187, replace line 181:
```ts
          const initialValue = spec.currentValue ?? "";
```
(was `spec.type === "select" && spec.currentValue ? spec.currentValue : ""`). `currentValue` is present only for non-sensitive fields, so secret fields still initialize to `""`.

- [ ] **Step 5: Add the `ReadableField` component**

In `settings-tab.tsx`, add this component next to `ToolSelectField` (e.g. just before `function ToolSelectField` at line 822). It mirrors `SecretField` minus the masking and the eye toggle:
```tsx
interface ReadableFieldProps {
  label: string;
  sublabel?: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
  placeholder: string;
  onRemove?: () => void;
}

function ReadableField({
  label,
  sublabel,
  value,
  onChange,
  configured,
  placeholder,
  onRemove,
}: ReadableFieldProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        <Badge variant={configured ? "default" : "secondary"} className="text-xs">
          {configured ? t("settings.tab.configured") : t("settings.tab.notConfigured")}
        </Badge>
      </div>
      {sublabel && <p className="text-xs text-muted-foreground">{sublabel}</p>}
      <div className="flex gap-2">
        <Input
          type="text"
          className="flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {onRemove && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("settings.tab.removeKeyTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.tab.removeKeyDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onRemove}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t("settings.tab.removeKey")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Branch the render on `sensitive` for `text` fields**

In `settings-tab.tsx`, in the `toolSecretSpecs.map` callback, replace the trailing `text` branch (the `return ( <SecretField ... /> )` at lines 693-705) with:
```tsx
            if (spec.sensitive === false) {
              return (
                <ReadableField
                  key={spec.key}
                  label={label}
                  sublabel={spec.description}
                  value={secretValue(spec.key)}
                  onChange={(v) => setSecretValue(spec.key, v)}
                  configured={isConfigured(spec.key)}
                  placeholder={isConfigured(spec.key) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
                  onRemove={isConfigured(spec.key) ? () => handleRemoveSecret(spec.key) : undefined}
                />
              );
            }
            return (
              <SecretField
                key={spec.key}
                label={label}
                sublabel={spec.description}
                value={secretValue(spec.key)}
                onChange={(v) => setSecretValue(spec.key, v)}
                configured={isConfigured(spec.key)}
                visible={secretVisible(spec.key)}
                onToggleVisibility={() => toggleSecretVisibility(spec.key)}
                placeholder={isConfigured(spec.key) ? t("settings.tab.keyPlaceholderSet") : t("settings.tab.keyPlaceholder")}
                onRemove={isConfigured(spec.key) ? () => handleRemoveSecret(spec.key) : undefined}
              />
            );
```

- [ ] **Step 7: Run the FE test and confirm it PASSES**

Run: `npm test -w @polyant/web -- settings-tab`
Expected: PASS (both cases).

- [ ] **Step 8: Typecheck the web package**

Run: `npm run typecheck -w @polyant/web`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/lib/api-types.ts "packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx" "packages/web/src/app/(admin)/instances/[slug]/settings-tab.test.tsx"
git commit -s -m "feat(web): render readable tool config fields as cleartext inputs"
```

---

## Task 4: Engine — demonstration migration (`http_allowed_domains` → readable)

**Files:**
- Modify: `packages/engine/src/agents/tools/http-request.tool.ts:86-92`

- [ ] **Step 1: Mark the allowlist field as readable**

In `http-request.tool.ts`, in the `http_allowed_domains` spec (the second entry of `requiredSecrets`, starting line 86), add `sensitive: false`:
```ts
    {
      key: "http_allowed_domains",
      type: "text",
      sensitive: false,
      label: "HTTP allowed domains (allowlist)",
      description:
        "Optional comma-separated FQDN allowlist (e.g. 'api.example.com,hooks.partner.io'). When set, requests to any other hostname are blocked. Subdomains are allowed: an entry 'example.com' matches 'api.example.com' but NOT 'badexample.com'. Leave empty to allow any public host (SSRF gates still apply).",
      optional: true,
    },
```
(The `http_api_key` field above is left as-is — it stays a secret by default.)

- [ ] **Step 2: Confirm the http-request tool test still passes**

Run: `npm test -w @polyant/engine -- http-request.tool`
Expected: PASS. The registration test (`registry.test.ts` lines 65-69 of `http-request.tool.test.ts`) only checks `specs.map(s => s.key)` and `s.optional` — adding `sensitive` does not break it.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/agents/tools/http-request.tool.ts
git commit -s -m "feat(tools): mark httpRequest allowlist as a readable (non-secret) field"
```

---

## Task 5: Full verification

- [ ] **Step 1: Engine — full test suite, typecheck, lint**

Run: `npm test -w @polyant/engine`
Expected: PASS (no regressions across the engine suite).

Run: `npm run typecheck -w @polyant/engine`
Expected: no errors.

Run: `npm run lint -w @polyant/engine`
Expected: no errors.

- [ ] **Step 2: Web — full test suite, typecheck, lint**

Run: `npm test -w @polyant/web`
Expected: PASS.

Run: `npm run typecheck -w @polyant/web`
Expected: no errors.

Run: `npm run lint -w @polyant/web`
Expected: no errors (the react-compiler rules are at `warn`).

- [ ] **Step 3: Final confirmation**

State explicitly that all suites pass with their output, that there is no DB migration, and that the change is backward-compatible (existing tools without `sensitive` behave exactly as before).

---

## Self-Review

**1. Spec coverage:**
- §3.1 `sensitive` on `RequiredSecretSpec` → Task 1 Step 4.
- §3.2 default-fill (text→true, select→false) → Task 1 Step 5 + tests Steps 1-2.
- §3.3 runtime access unchanged → not modified (no task needed; `ctx.secrets` untouched).
- §4 controller echoes `currentValue` for non-sensitive, `hasReadable` gate, `sensitive` in DTO → Task 2 (the spec flows through normalized so the DTO carries `sensitive`; tests in Step 1).
- §5.1 FE type → Task 3 Step 1.
- §5.2 render branch → Task 3 Steps 5-6.
- §5.3 prefill extension → Task 3 Step 4.
- §5.4 save path unchanged → not modified (no task needed).
- §6 storage/encryption/audit unchanged → no schema/crypto task (intentional).
- §7 demo migration → Task 4.
- §8 backward compat → verified by the unchanged per-tool raw-spec assertions + Task 5.
- §9 testing → Tasks 1-3 tests + Task 5.

**2. Placeholder scan:** No TBD/TODO; every code step shows full code.

**3. Type consistency:** `RequiredSecretSpec.sensitive?: boolean` is consistent across engine (registry) and web (api-types). `collectEnabledToolSecrets` / `attachReadableValues` / `RequiredSecretSpecWithValue` names match between the view module, its test, and the controller. `ReadableField` / `ReadableFieldProps` match between definition and use.

**Note on backward-compat assertions:** per-tool test files assert the **raw** `def.requiredSecrets` (e.g. `["hubspot_api_key"]`), which the normalizer never mutates — so only the normalized-output assertions in `registry.test.ts` needed updating (Task 1 Step 1). The full-suite run in Task 5 is the backstop for anything missed.
