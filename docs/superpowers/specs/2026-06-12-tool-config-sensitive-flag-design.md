# Design: `sensitive` flag for tool config parameters

- **Status:** Proposal / draft for review (no implementation yet)
- **Date:** 2026-06-12
- **Base:** `polyant-ai/polyant` `main`. All `file:line` references assume that base.
- **Scope:** let a tool declare, per config field, whether the value is a **secret** (masked in the admin UI, never echoed back by the API) or a **readable** value such as a base URL or an allowlist (shown in cleartext, echoed back so it can be displayed/edited). Presentation-only: storage and encryption are unchanged.

---

## 1. Summary

Today every tool declares its per-instance configuration via `requiredSecrets` on its `ToolDefinition`. Each entry is a `RequiredSecretSpec` (`{ key, type: "text" | "select", label?, description?, choices?, optional? }`). This list is surfaced by `GET /api/instances/:slug/tools/required-secrets` and rendered **dynamically** in the admin Settings tab — adding a tool that needs configuration requires **no frontend changes**.

The gap: `RequiredSecretSpec` has **no notion of secrecy**. Every `type: "text"` field is rendered masked (`SecretField`) and the API never returns its current value. There is no way for a tool to declare a **readable** field (e.g. a service base URL) that should be shown in cleartext and pre-filled for editing.

Interestingly, the **skills** subsystem already solved this: `RequiredEnvEntry` carries a `sensitive: boolean` flag, and `instance_skill_env` has an `encrypted` column. This design brings the **same `sensitive` concept** to tools, for terminology consistency across the framework.

This is a **framework, domain-agnostic** change: it extends the declaration contract, never hardcodes any instance- or tool-specific behavior.

### Out of scope (explicit)

- The hardcoded provider/infra secrets (`openai`, `anthropic`, `aws_*`, `langsmith`, `auth`, `deepgram`) in `settings-tab.tsx` / `secrets.store.ts` / `config-resolver.ts` — they remain hardcoded.
- The hardcoded channel definitions (`CHANNEL_DEFS` in `channels-tab.tsx`).
- Any new field `type` beyond the existing `text | select` (no `url`/`number`/`boolean`).
- Any change to storage or encryption at rest.

---

## 2. Decisions (from brainstorming)

| Question | Decision |
|---|---|
| What does "readable" mean? | **UI/API presentation only.** Readable fields are shown in cleartext and echoed by the API; secret fields stay masked and are never echoed. **At rest everything stays encrypted** in `instance_secrets` — no migration, no schema change. Encrypting a URL is harmless. |
| How far to extend "type"? | **Add `sensitive` only.** Keep `type: "text" \| "select"` unchanged. No new field types (YAGNI). |
| Flag name | **`sensitive`**, matching the skills subsystem (`RequiredEnvEntry.sensitive`) for cross-framework consistency. |
| Backward compatibility | **Mandatory and total.** Existing tools (no flag) behave exactly as today; existing stored secrets are untouched; the API change is purely additive. |

---

## 3. The contract change (engine)

### 3.1 `RequiredSecretSpec` (`packages/engine/src/agents/tools/registry.ts:57`)

Add one optional field:

```ts
export interface RequiredSecretSpec {
  key: string;
  type: "text" | "select";
  label?: string;
  description?: string;
  choices?: string[];
  optional?: boolean;
  /**
   * false  → readable value (e.g. a base URL): shown in cleartext in the admin
   *          UI and returned by the API so it can be displayed/edited.
   * true / undefined → secret: masked in the UI, never returned by the API.
   * Default depends on `type` (see normalizeRequiredSecrets): text → true, select → false.
   */
  sensitive?: boolean;
}
```

`ToolInfo.requiredSecrets` (same file, line 112) carries the same shape — no change needed beyond the added optional field.

### 3.2 Default fill in `normalizeRequiredSecrets` (`registry.ts:126`)

The normalizer is the single place where defaults are materialized. Rule (chosen to **preserve today's behavior byte-for-byte**):

- `type: "text"`  → `sensitive` defaults to **`true`** (today all text fields are masked and never echoed).
- `type: "select"` → `sensitive` defaults to **`false`** (today select fields already echo `currentValue` in cleartext).

Implementation: when normalizing, if `entry.sensitive === undefined`, set it to `entry.type === "select" ? false : true`. The shorthand string form (`"aws_access_key_id"`) expands to `{ key, type: "text" }` and therefore to `sensitive: true` — unchanged.

Validation rules (select requires non-empty `choices`, no empty keys) are unchanged.

### 3.3 No change to runtime access

Tools still read values via `ctx.secrets?.[key]` (decrypted by the config resolver). `sensitive` never affects runtime — it is purely a presentation contract for the admin UI/API.

---

## 4. API change (`/tools/required-secrets`)

File: `packages/engine/src/server/instances/instance-tools.controller.ts:18`.

Today the controller fetches stored secret values **only when there is a `select`** field (`hasSelect`), and attaches `currentValue` only to select specs. Generalize:

1. Rename the gate from `hasSelect` to **`hasReadable`** = "any spec with `sensitive === false`" (after normalization, this includes selects by default). Fetch `getAllSecretsById(instance.id)` when `hasReadable` is true.
2. In the map, attach `currentValue` to **every spec where `sensitive === false`** (when a stored value exists), not just selects.
3. Include `sensitive` in each returned spec so the frontend knows how to render.

Returned DTO (`RequiredSecretSpecWithValue`) gains the `sensitive` field (additive). Sensitive fields never carry `currentValue` — exactly as today.

**Security note:** echoing `currentValue` only for `sensitive === false` fields is the whole safety boundary. A field is readable **only** if its declaring tool opted in. The default (`text → sensitive: true`) means a tool author must take an explicit action to expose a value; the safe default is "secret".

---

## 5. Frontend change

### 5.1 `RequiredSecretSpec` type (`packages/web/src/lib/api-types.ts:118`)

Add `sensitive?: boolean` (the `currentValue?: string` field already exists). Additive.

### 5.2 Render branch (`settings-tab.tsx:676`)

In `toolSecretSpecs.map`:

- `type === "select"` → unchanged (`ToolSelectField`).
- `type === "text"` and `sensitive === false` → render a **plain readable `Input`** (no visibility toggle), pre-filled from `currentValue`.
- `type === "text"` and `sensitive !== false` → render `SecretField` (masked, with the eye toggle) — **exactly as today**.

### 5.3 Dirty-tracking / prefill (`settings-tab.tsx:174`)

The `initial` value is today pre-populated only for non-secret select fields (see the comment at line 128). Extend the same effect to populate `initial` from `currentValue` for **any** field with `sensitive === false`, so readable text fields show their stored value and dirty-tracking works. This reuses the existing mechanism — no new state shape.

### 5.4 Save path — unchanged

Both secret and readable values are PUT to `/secrets` and encrypted at rest. No change to the save handler.

---

## 6. Storage, encryption, audit — unchanged

- `instance_secrets` schema: **no new column, no migration.** Values stay AES-256-GCM encrypted at rest.
- Audit log: **key + type only**, never the value — unchanged. (Readable values are not logged either; uniform behavior.)
- `config-resolver` / `ctx.secrets`: unchanged.

---

## 7. Demonstration migration (optional, recommended)

Mark `http_allowed_domains` in `packages/engine/src/agents/tools/http-request.tool.ts:76` as `sensitive: false`. It is an FQDN allowlist, not a credential — it should be readable and pre-filled. This serves as a living example of the new flag and immediately improves that tool's UX. Scoped to a single field; no behavioral change beyond presentation.

---

## 8. Backward compatibility

| Surface | Before | After (no flag declared) |
|---|---|---|
| Existing `text` secret | masked, value never returned | `sensitive` defaults to `true` → **identical** |
| Existing `select` | value echoed in cleartext | `sensitive` defaults to `false` → **identical** |
| Shorthand string `"key"` | `{ key, type: "text" }`, masked | defaults to `sensitive: true` → **identical** |
| Stored secrets in DB | encrypted | untouched, still encrypted |
| API response | no `sensitive` field | `sensitive` added (additive) |
| Runtime `ctx.secrets` | decrypted map | unchanged |

No migration. No data touched. The only observable change for existing tools is an extra `sensitive` field in the API response, which the current frontend ignores.

---

## 9. Testing

Engine unit tests:

- `normalizeRequiredSecrets`:
  - text spec with no `sensitive` → resolves to `true`.
  - select spec with no `sensitive` → resolves to `false`.
  - explicit `sensitive` override (text → false, select → true) is preserved.
  - shorthand string → `{ type: "text", sensitive: true }`.
  - existing validation (select requires `choices`, no empty keys) still throws.
- `/tools/required-secrets` controller:
  - a readable text field (`sensitive: false`) with a stored value → `currentValue` present.
  - a secret text field → `currentValue` absent.
  - `sensitive` present on every returned spec.
  - `hasReadable` gate triggers the secrets fetch when any non-sensitive field exists (and skips it when all are sensitive).

Frontend (if component coverage exists for `settings-tab`): a `sensitive: false` text spec renders a plain input pre-filled with `currentValue`; a `sensitive: true` spec renders the masked `SecretField`.

---

## 10. Files touched (summary)

| File | Change |
|---|---|
| `packages/engine/src/agents/tools/registry.ts` | add `sensitive?` to `RequiredSecretSpec`; default-fill in `normalizeRequiredSecrets` |
| `packages/engine/src/server/instances/instance-tools.controller.ts` | `hasReadable` gate; echo `currentValue` for non-sensitive; include `sensitive` in DTO |
| `packages/web/src/lib/api-types.ts` | add `sensitive?` to `RequiredSecretSpec` |
| `packages/web/src/app/(admin)/instances/[slug]/settings-tab.tsx` | render branch (plain input vs `SecretField`); extend `initial` prefill |
| `packages/engine/src/agents/tools/http-request.tool.ts` | (optional) mark `http_allowed_domains` `sensitive: false` |
| tests | `registry` + controller unit tests |
