# Conversation Lifecycle Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-instance, DB-configured hooks that run actions (v1: execute a tool with template-rendered args) synchronously at four conversation lifecycle events.

**Architecture:** New `packages/engine/src/hooks/` module (schema, store with TTL cache, template renderer, action-executor registry, runner) wired explicitly into `pipeline.ts` at four points. Management API controller + admin UI "Hooks" tab. Spec: `docs/superpowers/specs/2026-06-10-hook-system-design.md`.

**Tech Stack:** TypeScript ESM, Drizzle ORM (PostgreSQL), NestJS 11, Zod, vitest, Next.js 16 + shadcn/ui.

**Conventions that apply to every task:** ESM imports end in `.js`; named exports only; kebab-case filenames; commits via `git commit -F <msg-file>` (this shell corrupts multi-line `-m`) with both `Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>` and `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailers. Run engine tests with `npx vitest run <file> -w false` from `packages/engine` (or `npm run test:unit -w @polyant/engine`).

---

### Task 1: Hook domain types + args template renderer

**Files:**
- Create: `packages/engine/src/hooks/hook-types.ts`
- Create: `packages/engine/src/hooks/hook-template.ts`
- Test: `packages/engine/src/hooks/hook-template.test.ts`

- [ ] **Step 1: Create the domain types** (no test — pure type declarations)

```ts
// packages/engine/src/hooks/hook-types.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { InstanceSlug } from "../instances/identifiers.js";
import type { ConversationStateApi } from "../conversations/state.buffer.js";
import type { ChatRequest } from "../ai-gateway/types.js";

/** Conversation lifecycle events a hook can subscribe to. */
export const HOOK_EVENTS = [
  "conversation_start",
  "message_received",
  "response_generated",
  "response_sent",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Action types. v1 implements only `tool`; future types are additive. */
export const HOOK_ACTION_TYPES = ["tool"] as const;

export type HookActionType = (typeof HOOK_ACTION_TYPES)[number];

/**
 * Per-action configuration stored in `instance_hooks.action_config` (jsonb).
 * For `tool` actions: which registered tool to run and the args template
 * ({{path}} placeholders resolved against the event payload).
 */
export interface HookActionConfig {
  toolName: string;
  args: Record<string, unknown>;
}

/** Server-built event payload — the ONLY source for template placeholders. */
export interface HookEventPayload {
  instance: { slug: string };
  conversation: { id: string };
  channel: { type: string; id: string };
  user: { name: string };
  message: { text: string };
  /** Present only on response_generated / response_sent. */
  response?: { text: string };
}

/** Runtime context threaded from the pipeline into hook execution. */
export interface HookRunContext {
  instanceId: InstanceSlug;
  conversationId: string;
  secrets: Record<string, string>;
  apiKeys?: ChatRequest["apiKeys"];
  provider?: string;
  /** Per-run conversation state API (same buffer as the supervisor's tools). */
  state?: ConversationStateApi;
  /** Pipeline abort signal — remaining hooks are skipped once aborted. */
  abortSignal?: AbortSignal;
}

/** A hydrated `instance_hooks` row. */
export interface InstanceHookRow {
  id: string;
  instanceId: string;
  event: HookEvent;
  actionType: HookActionType;
  actionConfig: HookActionConfig;
  enabled: boolean;
  position: number;
  timeoutMs: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One executor per action type, resolved by the runner from a registry map. */
export interface HookActionExecutor {
  execute(
    hook: InstanceHookRow,
    payload: HookEventPayload,
    ctx: HookRunContext,
  ): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests for the template renderer**

```ts
// packages/engine/src/hooks/hook-template.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderArgsTemplate } from "./hook-template.js";
import type { HookEventPayload } from "./hook-types.js";

const payload: HookEventPayload = {
  instance: { slug: "demo" },
  conversation: { id: "demo:whatsapp:+391234" },
  channel: { type: "whatsapp", id: "+391234" },
  user: { name: "Paolo" },
  message: { text: "ciao" },
  response: { text: "hello there" },
};

describe("renderArgsTemplate", () => {
  it("should_replace_placeholder_when_inside_string", () => {
    const { args, unresolved } = renderArgsTemplate(
      { query: "phone {{channel.id}}" },
      payload,
    );
    expect(args).toEqual({ query: "phone +391234" });
    expect(unresolved).toEqual([]);
  });

  it("should_replace_multiple_placeholders_in_one_string", () => {
    const { args } = renderArgsTemplate(
      { note: "{{user.name}} via {{channel.type}}" },
      payload,
    );
    expect(args).toEqual({ note: "Paolo via whatsapp" });
  });

  it("should_render_nested_objects_and_arrays", () => {
    const { args } = renderArgsTemplate(
      { filters: [{ value: "{{channel.id}}" }], meta: { conv: "{{conversation.id}}" } },
      payload,
    );
    expect(args).toEqual({
      filters: [{ value: "+391234" }],
      meta: { conv: "demo:whatsapp:+391234" },
    });
  });

  it("should_pass_through_non_string_values_verbatim", () => {
    const { args } = renderArgsTemplate(
      { limit: 5, active: true, nothing: null },
      payload,
    );
    expect(args).toEqual({ limit: 5, active: true, nothing: null });
  });

  it("should_render_empty_and_report_unresolved_when_path_missing", () => {
    const { args, unresolved } = renderArgsTemplate(
      { q: "x {{payload.bogus}} y" },
      payload,
    );
    expect(args).toEqual({ q: "x  y" });
    expect(unresolved).toEqual(["payload.bogus"]);
  });

  it("should_render_empty_when_response_absent", () => {
    const { text: _drop, ...rest } = payload.response!;
    void _drop;
    void rest;
    const noResponse: HookEventPayload = { ...payload, response: undefined };
    const { args, unresolved } = renderArgsTemplate({ r: "{{response.text}}" }, noResponse);
    expect(args).toEqual({ r: "" });
    expect(unresolved).toEqual(["response.text"]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run from `packages/engine`: `npx vitest run src/hooks/hook-template.test.ts -w false`
Expected: FAIL — `Cannot find module './hook-template.js'`

- [ ] **Step 4: Implement the renderer**

```ts
// packages/engine/src/hooks/hook-template.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Args-template renderer for hooks. Deep-walks a JSON args object and replaces
 * `{{path.to.field}}` placeholders inside STRING values with values resolved
 * from the event payload. Non-string values pass through verbatim. Missing
 * paths render as empty string and are reported in `unresolved`.
 */

import type { HookEventPayload } from "./hook-types.js";

const HOOK_TEMPLATE_RE = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

export interface RenderedArgs {
  args: Record<string, unknown>;
  /** Placeholder paths that did not resolve to a value (rendered as ""). */
  unresolved: string[];
}

function resolvePathValue(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderArgsTemplate(
  args: Record<string, unknown>,
  payload: HookEventPayload,
): RenderedArgs {
  const unresolved: string[] = [];
  const source = payload as unknown as Record<string, unknown>;

  const renderString = (value: string): string =>
    value.replace(HOOK_TEMPLATE_RE, (_match, path: string) => {
      const resolved = resolvePathValue(source, path);
      if (resolved === undefined || resolved === null) {
        unresolved.push(path);
        return "";
      }
      return stringify(resolved);
    });

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return renderString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };

  return { args: walk(args) as Record<string, unknown>, unresolved };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/hooks/hook-template.test.ts -w false`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

`feat(hooks): add hook domain types and args template renderer`

---

### Task 2: DB schema + migration

**Files:**
- Create: `packages/engine/src/hooks/hooks.schema.ts`
- Create: `packages/engine/src/database/migrations/0046_add_instance_hooks.sql`
- Modify: `packages/engine/src/database/migrations/meta/_journal.json`

- [ ] **Step 1: Create the Drizzle schema**

```ts
// packages/engine/src/hooks/hooks.schema.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, varchar, boolean, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { instances } from "../instances/schema.js";
import type { HookActionConfig } from "./hook-types.js";

/**
 * Per-instance lifecycle hooks: run an action (v1: a tool with template args)
 * when a conversation lifecycle event fires. See
 * docs/superpowers/specs/2026-06-10-hook-system-design.md.
 */
export const instanceHooks = pgTable(
  "instance_hooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    event: varchar("event", { length: 32 }).notNull(),
    actionType: varchar("action_type", { length: 32 }).notNull().default("tool"),
    actionConfig: jsonb("action_config").$type<HookActionConfig>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    position: integer("position").notNull().default(0),
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_instance_hooks_instance_event").on(table.instanceId, table.event),
  ],
);
```

- [ ] **Step 2: Write the migration manually** (drizzle-kit has no snapshots in this repo — never run bare `generate`)

```sql
-- packages/engine/src/database/migrations/0046_add_instance_hooks.sql
CREATE TABLE IF NOT EXISTS "instance_hooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" uuid NOT NULL REFERENCES "instances"("id") ON DELETE CASCADE,
  "event" varchar(32) NOT NULL,
  "action_type" varchar(32) NOT NULL DEFAULT 'tool',
  "action_config" jsonb NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "position" integer NOT NULL DEFAULT 0,
  "timeout_ms" integer NOT NULL DEFAULT 10000,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instance_hooks_instance_event" ON "instance_hooks" ("instance_id", "event");
```

- [ ] **Step 3: Register the migration in the journal**

Append to the `entries` array in `packages/engine/src/database/migrations/meta/_journal.json` (after the `0045_add_debug_payload` entry):

```json
    {
      "idx": 42,
      "version": "7",
      "when": 1779667200000,
      "tag": "0046_add_instance_hooks",
      "breakpoints": true
    }
```

- [ ] **Step 4: Apply the migration against the local DB**

Run from repo root: `docker compose up -d postgres && npm run db:migrate`
Expected: `Running migrations from .../migrations` then exit 0. Verify: `docker compose exec postgres psql -U polyant -d polyant -c "\d instance_hooks"` shows the 10 columns (adjust user/db to `.env` values).

- [ ] **Step 5: Commit**

`feat(hooks): add instance_hooks table schema and migration`

---

### Task 3: Hooks store (CRUD + cached lookup)

**Files:**
- Create: `packages/engine/src/hooks/hooks.store.ts`
- Test: `packages/engine/src/hooks/hooks.store.integration.test.ts`

- [ ] **Step 1: Write the failing integration test** (self-skips without a migrated DB, same pattern as `conversations/state.store.integration.test.ts`)

```ts
// packages/engine/src/hooks/hooks.store.integration.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for the instance_hooks store. Requires a migrated Postgres
 * (docker compose up -d postgres && npm run db:migrate) and at least one
 * instance row; self-skips otherwise so a bare `npm test` stays green.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../database/client.js";
import { instances } from "../instances/schema.js";
import { eq } from "drizzle-orm";
import {
  listHooks,
  createHook,
  updateHook,
  deleteHook,
  getEnabledHooks,
  invalidateHooksCache,
} from "./hooks.store.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "../instances/identifiers.js";

const SLUG = "itest-hooks-store";
let instanceUuid: InstanceUuid | undefined;

async function setupInstance(): Promise<InstanceUuid | undefined> {
  try {
    const rows = await Promise.race([
      db
        .insert(instances)
        .values({ slug: SLUG, name: "itest hooks" })
        .onConflictDoNothing()
        .returning({ id: instances.id }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("db timeout")), 3000)),
    ]);
    if (rows.length > 0) return asInstanceUuid(rows[0].id);
    const existing = await db.select({ id: instances.id }).from(instances).where(eq(instances.slug, SLUG)).limit(1);
    return existing[0] ? asInstanceUuid(existing[0].id) : undefined;
  } catch {
    return undefined;
  }
}

beforeAll(async () => {
  instanceUuid = await setupInstance();
});

afterAll(async () => {
  if (!instanceUuid) return;
  await db.delete(instances).where(eq(instances.id, instanceUuid)); // cascades to hooks
});

describe("hooks store (integration)", () => {
  it("should_crud_and_order_hooks_when_db_available", { timeout: 15000 }, async () => {
    if (!instanceUuid) return; // no DB — skip silently
    const uuid = instanceUuid;

    // create two hooks on the same event, out-of-order positions
    const second = await createHook(uuid, {
      event: "conversation_start",
      actionType: "tool",
      actionConfig: { toolName: "toolB", args: {} },
      position: 2,
    });
    const first = await createHook(uuid, {
      event: "conversation_start",
      actionType: "tool",
      actionConfig: { toolName: "toolA", args: { q: "{{channel.id}}" } },
      position: 1,
    });
    const disabled = await createHook(uuid, {
      event: "conversation_start",
      actionType: "tool",
      actionConfig: { toolName: "toolC", args: {} },
      enabled: false,
    });

    // list returns all three
    const all = await listHooks(uuid);
    expect(all.map((h) => h.id).sort()).toEqual([first.id, second.id, disabled.id].sort());

    // cached read returns only enabled, ordered by position
    invalidateHooksCache(asInstanceSlug(SLUG));
    const enabled = await getEnabledHooks(asInstanceSlug(SLUG), "conversation_start");
    expect(enabled.map((h) => h.actionConfig.toolName)).toEqual(["toolA", "toolB"]);

    // other events are empty
    expect(await getEnabledHooks(asInstanceSlug(SLUG), "response_sent")).toEqual([]);

    // update flips enabled and patches config
    const updated = await updateHook(uuid, disabled.id, { enabled: true, timeoutMs: 5000 });
    expect(updated?.enabled).toBe(true);
    expect(updated?.timeoutMs).toBe(5000);

    // cache invalidation makes the new hook visible
    invalidateHooksCache(asInstanceSlug(SLUG));
    const enabledAfter = await getEnabledHooks(asInstanceSlug(SLUG), "conversation_start");
    expect(enabledAfter).toHaveLength(3);

    // delete is instance-scoped
    expect(await deleteHook(uuid, first.id)).toBe(true);
    expect(await deleteHook(uuid, first.id)).toBe(false);
  });

  it("should_return_empty_when_slug_unknown", async () => {
    if (!instanceUuid) return;
    expect(await getEnabledHooks(asInstanceSlug("itest-hooks-nope"), "message_received")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/hooks.store.integration.test.ts -w false`
Expected: FAIL — `Cannot find module './hooks.store.js'`

- [ ] **Step 3: Implement the store**

```ts
// packages/engine/src/hooks/hooks.store.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, asc, eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { instanceHooks } from "./hooks.schema.js";
import { resolveInstanceId } from "../instances/resolve-instance-id.js";
import type { InstanceSlug, InstanceUuid } from "../instances/identifiers.js";
import { TtlCache } from "../utils/ttl-cache.js";
import type {
  HookActionConfig,
  HookActionType,
  HookEvent,
  InstanceHookRow,
} from "./hook-types.js";

/** Cached enabled-hooks lookup, keyed by instance slug (the pipeline's id). */
const cache = new TtlCache<string, Map<HookEvent, InstanceHookRow[]>>({
  maxSize: 200,
  ttlMs: 30_000,
});

export function invalidateHooksCache(slug: InstanceSlug): void {
  cache.delete(slug);
}

function toRow(r: typeof instanceHooks.$inferSelect): InstanceHookRow {
  return {
    id: r.id,
    instanceId: r.instanceId,
    event: r.event as HookEvent,
    actionType: r.actionType as HookActionType,
    actionConfig: r.actionConfig,
    enabled: r.enabled,
    position: r.position,
    timeoutMs: r.timeoutMs,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export interface CreateHookInput {
  event: HookEvent;
  actionType: HookActionType;
  actionConfig: HookActionConfig;
  enabled?: boolean;
  position?: number;
  timeoutMs?: number;
}

export async function listHooks(instanceId: InstanceUuid): Promise<InstanceHookRow[]> {
  const rows = await db
    .select()
    .from(instanceHooks)
    .where(eq(instanceHooks.instanceId, instanceId))
    .orderBy(asc(instanceHooks.event), asc(instanceHooks.position), asc(instanceHooks.createdAt));
  return rows.map(toRow);
}

export async function createHook(
  instanceId: InstanceUuid,
  input: CreateHookInput,
): Promise<InstanceHookRow> {
  const rows = await db
    .insert(instanceHooks)
    .values({
      instanceId,
      event: input.event,
      actionType: input.actionType,
      actionConfig: input.actionConfig,
      enabled: input.enabled ?? true,
      position: input.position ?? 0,
      timeoutMs: input.timeoutMs ?? 10_000,
    })
    .returning();
  return toRow(rows[0]);
}

export async function updateHook(
  instanceId: InstanceUuid,
  hookId: string,
  patch: Partial<CreateHookInput>,
): Promise<InstanceHookRow | undefined> {
  const rows = await db
    .update(instanceHooks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(instanceHooks.id, hookId), eq(instanceHooks.instanceId, instanceId)))
    .returning();
  return rows[0] ? toRow(rows[0]) : undefined;
}

export async function deleteHook(instanceId: InstanceUuid, hookId: string): Promise<boolean> {
  const rows = await db
    .delete(instanceHooks)
    .where(and(eq(instanceHooks.id, hookId), eq(instanceHooks.instanceId, instanceId)))
    .returning({ id: instanceHooks.id });
  return rows.length > 0;
}

/**
 * Enabled hooks for one (instance, event), ordered by position then createdAt.
 * One query per instance per TTL window — all events are loaded and grouped.
 * Unknown slugs resolve to an empty list (cached, so they cost one lookup).
 */
export async function getEnabledHooks(
  slug: InstanceSlug,
  event: HookEvent,
): Promise<InstanceHookRow[]> {
  let byEvent = cache.get(slug);
  if (!byEvent) {
    byEvent = new Map();
    const instanceId = await resolveInstanceId(slug);
    if (instanceId) {
      const rows = await db
        .select()
        .from(instanceHooks)
        .where(and(eq(instanceHooks.instanceId, instanceId), eq(instanceHooks.enabled, true)))
        .orderBy(asc(instanceHooks.position), asc(instanceHooks.createdAt));
      for (const row of rows.map(toRow)) {
        const list = byEvent.get(row.event) ?? [];
        list.push(row);
        byEvent.set(row.event, list);
      }
    }
    cache.set(slug, byEvent);
  }
  return byEvent.get(event) ?? [];
}
```

- [ ] **Step 4: Run test to verify it passes** (with DB up)

Run: `npx vitest run src/hooks/hooks.store.integration.test.ts -w false`
Expected: PASS (or silent skip without DB — run with DB at least once)

- [ ] **Step 5: Commit**

`feat(hooks): add instance hooks store with cached event lookup`

---

### Task 4: Extract `fillMissingKeysWithNull` from the tool registry

The hooks tool-executor must validate template-rendered args exactly like the supervisor path does (strict-mode schemas have every key `required` but `.nullable()`). Extract the existing null-fill preprocess from `buildTool` so both paths share it.

**Files:**
- Modify: `packages/engine/src/agents/tools/registry.ts:252-262`
- Test: `packages/engine/src/agents/tools/registry.test.ts` (add cases)

- [ ] **Step 1: Write the failing test** — append to the existing describe blocks in `registry.test.ts`:

```ts
describe("fillMissingKeysWithNull", () => {
  it("should_fill_missing_object_keys_with_null", () => {
    const schema = z.object({ a: z.string().nullable(), b: z.number().nullable() });
    expect(fillMissingKeysWithNull(schema, { a: "x" })).toEqual({ a: "x", b: null });
  });

  it("should_pass_through_non_object_schema_or_value", () => {
    const schema = z.object({ a: z.string().nullable() });
    expect(fillMissingKeysWithNull(z.string(), "v")).toBe("v");
    expect(fillMissingKeysWithNull(schema, null)).toBe(null);
    expect(fillMissingKeysWithNull(schema, [1])).toEqual([1]);
  });
});
```

Add `fillMissingKeysWithNull` to the existing `./registry.js` import in the test file (and `z` from `zod` if not already imported).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/tools/registry.test.ts -w false`
Expected: FAIL — `fillMissingKeysWithNull` is not exported

- [ ] **Step 3: Implement the extraction** — in `registry.ts`, add the exported helper above `buildTool` and replace the inline preprocess body:

```ts
/**
 * Fill keys missing from `val` with `null` for ZodObject schemas. Strict-mode
 * schemas mark every key required-but-nullable; non-strict models (and hook
 * configs) legitimately omit irrelevant fields. Shared by `buildTool`'s
 * runtime preprocess and the hooks tool-action executor.
 */
export function fillMissingKeysWithNull(parameters: z.ZodType, val: unknown): unknown {
  if (!(parameters instanceof z.ZodObject)) return val;
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const shape = (parameters as z.ZodObject<z.ZodRawShape>).shape;
  const filled: Record<string, unknown> = { ...(val as Record<string, unknown>) };
  for (const key of Object.keys(shape)) {
    if (!(key in filled)) filled[key] = null;
  }
  return filled;
}
```

And in `buildTool` replace the `runtimeParameters` assignment with:

```ts
  const runtimeParameters = parameters instanceof z.ZodObject
    ? (z.preprocess((val) => fillMissingKeysWithNull(parameters, val), parameters) as unknown as typeof parameters)
    : parameters;
```

- [ ] **Step 4: Run the full registry + strict-mode suites to verify no regression**

Run: `npx vitest run src/agents/tools/registry.test.ts src/agents/tools/strict-mode.test.ts -w false`
Expected: PASS

- [ ] **Step 5: Commit**

`refactor(tools): extract fillMissingKeysWithNull from buildTool preprocess`

---

### Task 5: Tool action executor

**Files:**
- Create: `packages/engine/src/hooks/actions/tool-action.ts`
- Test: `packages/engine/src/hooks/actions/tool-action.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/src/hooks/actions/tool-action.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const { registryMock } = vi.hoisted(() => ({
  registryMock: new Map<string, unknown>(),
}));

vi.mock("../../agents/tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/tools/registry.js")>();
  return {
    ...actual,
    getToolRegistry: () => registryMock,
  };
});

vi.mock("../../audit/audit-logger.js", () => ({
  createAuditLogger: () => ({ log: vi.fn() }),
}));

import { toolActionExecutor } from "./tool-action.js";
import type { HookEventPayload, HookRunContext, InstanceHookRow } from "../hook-types.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

const payload: HookEventPayload = {
  instance: { slug: "demo" },
  conversation: { id: "demo:whatsapp:+39" },
  channel: { type: "whatsapp", id: "+39" },
  user: { name: "Paolo" },
  message: { text: "ciao" },
};

const ctx: HookRunContext = {
  instanceId: asInstanceSlug("demo"),
  conversationId: "demo:whatsapp:+39",
  secrets: { some_key: "v" },
};

function hookFor(toolName: string, args: Record<string, unknown>): InstanceHookRow {
  return {
    id: "h1",
    instanceId: "u1",
    event: "conversation_start",
    actionType: "tool",
    actionConfig: { toolName, args },
    enabled: true,
    position: 0,
    timeoutMs: 10_000,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("toolActionExecutor", () => {
  const executeMock = vi.fn();

  beforeEach(() => {
    registryMock.clear();
    executeMock.mockReset().mockResolvedValue({ ok: true });
    registryMock.set("lookup", {
      name: "lookup",
      description: "test tool",
      create: () => ({
        parameters: z.object({ query: z.string().nullable(), limit: z.number().nullable() }),
        execute: executeMock,
      }),
    });
  });

  it("should_render_args_and_execute_tool", async () => {
    await toolActionExecutor.execute(hookFor("lookup", { query: "{{channel.id}}" }), payload, ctx);
    expect(executeMock).toHaveBeenCalledWith({ query: "+39", limit: null });
  });

  it("should_throw_when_tool_not_registered", async () => {
    await expect(
      toolActionExecutor.execute(hookFor("missing", {}), payload, ctx),
    ).rejects.toThrow(/not registered/);
  });

  it("should_throw_when_tool_is_meta_tool", async () => {
    registryMock.set("spawnTask", { name: "spawnTask", description: "", metaTool: true, create: () => ({ parameters: z.object({}), execute: executeMock }) });
    await expect(
      toolActionExecutor.execute(hookFor("spawnTask", {}), payload, ctx),
    ).rejects.toThrow(/meta-tool/);
  });

  it("should_throw_when_rendered_args_fail_schema", async () => {
    await toolActionExecutor.execute(hookFor("lookup", { query: 42 } as Record<string, unknown>), payload, ctx)
      .then(
        () => { throw new Error("expected rejection"); },
        (err: Error) => expect(err.message).toMatch(/schema/),
      );
    expect(executeMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/actions/tool-action.test.ts -w false`
Expected: FAIL — `Cannot find module './tool-action.js'`

- [ ] **Step 3: Implement the executor**

```ts
// packages/engine/src/hooks/actions/tool-action.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { getToolRegistry, fillMissingKeysWithNull } from "../../agents/tools/registry.js";
import { createAuditLogger } from "../../audit/audit-logger.js";
import { renderArgsTemplate } from "../hook-template.js";
import type { HookActionExecutor } from "../hook-types.js";

/**
 * `tool` action: execute a registered tool with statically-configured,
 * template-rendered args. Throws on misconfiguration (missing tool, meta-tool,
 * schema mismatch) — the runner catches, audits, and continues.
 */
export const toolActionExecutor: HookActionExecutor = {
  async execute(hook, payload, ctx) {
    const { toolName, args } = hook.actionConfig;
    const def = getToolRegistry().get(toolName);
    if (!def) throw new Error(`tool "${toolName}" is not registered`);
    if (def.metaTool) throw new Error(`tool "${toolName}" is a meta-tool and cannot be used in hooks`);

    const { args: rendered, unresolved } = renderArgsTemplate(args ?? {}, payload);
    if (unresolved.length > 0) {
      console.warn(
        `[hooks] ${hook.event} "${toolName}": unresolved placeholder(s) ${unresolved.join(", ")} — rendered as empty string`,
      );
    }

    const { parameters, execute } = def.create({
      instanceId: ctx.instanceId,
      secrets: ctx.secrets,
      audit: createAuditLogger(toolName, ctx.instanceId, ctx.conversationId),
      conversationId: ctx.conversationId,
      apiKeys: ctx.apiKeys,
      provider: ctx.provider,
      state: ctx.state,
    });

    const parsed = parameters.safeParse(fillMissingKeysWithNull(parameters, rendered));
    if (!parsed.success) {
      throw new Error(
        `args do not match tool "${toolName}" schema: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    await execute(parsed.data);
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/actions/tool-action.test.ts -w false`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

`feat(hooks): add tool action executor with schema validation`

---

### Task 6: Hook runner

**Files:**
- Create: `packages/engine/src/hooks/hook-runner.ts`
- Test: `packages/engine/src/hooks/hook-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/src/hooks/hook-runner.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getEnabledHooksMock, executeMock, auditLogMock } = vi.hoisted(() => ({
  getEnabledHooksMock: vi.fn(),
  executeMock: vi.fn(),
  auditLogMock: vi.fn(),
}));

vi.mock("./hooks.store.js", () => ({
  getEnabledHooks: getEnabledHooksMock,
}));

vi.mock("./actions/tool-action.js", () => ({
  toolActionExecutor: { execute: executeMock },
}));

vi.mock("../audit/audit-logger.js", () => ({
  createAuditLogger: () => ({ log: auditLogMock }),
}));

import { runHooks } from "./hook-runner.js";
import type { HookEventPayload, HookRunContext, InstanceHookRow } from "./hook-types.js";
import { asInstanceSlug } from "../instances/identifiers.js";

const payload: HookEventPayload = {
  instance: { slug: "demo" },
  conversation: { id: "c1" },
  channel: { type: "whatsapp", id: "+39" },
  user: { name: "P" },
  message: { text: "hi" },
};

const baseCtx: HookRunContext = {
  instanceId: asInstanceSlug("demo"),
  conversationId: "c1",
  secrets: {},
};

function hook(id: string, overrides: Partial<InstanceHookRow> = {}): InstanceHookRow {
  return {
    id,
    instanceId: "u1",
    event: "message_received",
    actionType: "tool",
    actionConfig: { toolName: `tool-${id}`, args: {} },
    enabled: true,
    position: 0,
    timeoutMs: 10_000,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("runHooks", () => {
  beforeEach(() => {
    getEnabledHooksMock.mockReset().mockResolvedValue([]);
    executeMock.mockReset().mockResolvedValue(undefined);
    auditLogMock.mockReset();
  });

  it("should_execute_hooks_sequentially_in_store_order", async () => {
    const order: string[] = [];
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock.mockImplementation(async (h: InstanceHookRow) => {
      order.push(h.id);
    });
    await runHooks("message_received", payload, baseCtx);
    expect(order).toEqual(["a", "b"]);
    expect(auditLogMock).toHaveBeenCalledTimes(2);
    expect(auditLogMock.mock.calls[0][0]).toMatchObject({ success: true });
  });

  it("should_continue_after_a_failing_hook", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    await runHooks("message_received", payload, baseCtx);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(auditLogMock.mock.calls[0][0]).toMatchObject({ success: false, error: "boom" });
    expect(auditLogMock.mock.calls[1][0]).toMatchObject({ success: true });
  });

  it("should_timeout_a_slow_hook_and_continue", async () => {
    getEnabledHooksMock.mockResolvedValue([hook("slow", { timeoutMs: 1000 }), hook("fast")]);
    vi.useFakeTimers();
    executeMock.mockImplementation((h: InstanceHookRow) =>
      h.id === "slow" ? new Promise(() => {}) : Promise.resolve(),
    );
    const run = runHooks("message_received", payload, baseCtx);
    await vi.advanceTimersByTimeAsync(1001);
    await run;
    vi.useRealTimers();
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(auditLogMock.mock.calls[0][0].success).toBe(false);
    expect(auditLogMock.mock.calls[0][0].error).toMatch(/timed out/);
  });

  it("should_skip_remaining_hooks_when_aborted", async () => {
    const controller = new AbortController();
    getEnabledHooksMock.mockResolvedValue([hook("a"), hook("b")]);
    executeMock.mockImplementation(async () => {
      controller.abort();
    });
    await runHooks("message_received", payload, { ...baseCtx, abortSignal: controller.signal });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("should_skip_unknown_action_types", async () => {
    getEnabledHooksMock.mockResolvedValue([
      hook("x", { actionType: "future_thing" as InstanceHookRow["actionType"] }),
    ]);
    await runHooks("message_received", payload, baseCtx);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("should_swallow_store_errors", async () => {
    getEnabledHooksMock.mockRejectedValue(new Error("db down"));
    await expect(runHooks("message_received", payload, baseCtx)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/hook-runner.test.ts -w false`
Expected: FAIL — `Cannot find module './hook-runner.js'`

- [ ] **Step 3: Implement the runner**

```ts
// packages/engine/src/hooks/hook-runner.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { errMsg } from "../utils/error.js";
import { createAuditLogger } from "../audit/audit-logger.js";
import { getEnabledHooks } from "./hooks.store.js";
import { toolActionExecutor } from "./actions/tool-action.js";
import type {
  HookActionExecutor,
  HookActionType,
  HookEvent,
  HookEventPayload,
  HookRunContext,
  InstanceHookRow,
} from "./hook-types.js";

/** Action-type → executor. Future action types register here. */
const executors = new Map<HookActionType, HookActionExecutor>([
  ["tool", toolActionExecutor],
]);

function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`hook ${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Run all enabled hooks for (instance, event), sequentially in position order.
 * Observe-only contract: every failure (load, executor, timeout) is logged and
 * swallowed — hooks never block the pipeline. Audit records the outcome but
 * never the rendered args (PII).
 */
export async function runHooks(
  event: HookEvent,
  payload: HookEventPayload,
  ctx: HookRunContext,
): Promise<void> {
  let hooks: InstanceHookRow[];
  try {
    hooks = await getEnabledHooks(ctx.instanceId, event);
  } catch (err) {
    console.error(`[hooks] failed to load hooks for ${ctx.instanceId}/${event}:`, errMsg(err));
    return;
  }
  if (hooks.length === 0) return;

  for (const hook of hooks) {
    if (ctx.abortSignal?.aborted) return;
    const executor = executors.get(hook.actionType);
    if (!executor) {
      console.warn(`[hooks] ${event} hook ${hook.id}: unknown action type "${hook.actionType}" — skipping`);
      continue;
    }
    const toolName = hook.actionConfig.toolName;
    const audit = createAuditLogger(`hook:${toolName}`, ctx.instanceId, ctx.conversationId);
    const started = Date.now();
    try {
      await withTimeout(executor.execute(hook, payload, ctx), hook.timeoutMs, `${event}/${toolName}`);
      audit.log({
        action: `hook:${event}`,
        success: true,
        durationMs: Date.now() - started,
        details: { actionType: hook.actionType },
      });
    } catch (err) {
      console.error(`[hooks] ${event} hook ${hook.id} (${toolName}) failed:`, errMsg(err));
      audit.log({
        action: `hook:${event}`,
        success: false,
        error: errMsg(err),
        durationMs: Date.now() - started,
        details: { actionType: hook.actionType },
      });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/hook-runner.test.ts -w false`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

`feat(hooks): add hook runner with timeout and log-and-continue semantics`

---

### Task 7: Pipeline wiring

**Files:**
- Modify: `packages/engine/src/pipeline.ts` (PipelineContext, preparePipeline, runPipelinePre, runPipelinePost)
- Modify: `packages/engine/src/index.ts:187` and `:255` (thread abortSignal into runPipelinePre)
- Test: `packages/engine/src/pipeline-hooks.test.ts`

- [ ] **Step 1: Write the failing tests for the payload builder**

```ts
// packages/engine/src/pipeline-hooks.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildHookPayload, type PipelineContext } from "./pipeline.js";
import { asInstanceSlug } from "./instances/identifiers.js";

function ctxWith(overrides: Partial<PipelineContext>): PipelineContext {
  return {
    pipelineStart: 0,
    instanceId: asInstanceSlug("demo"),
    conversationId: "demo:whatsapp:+39",
    conversationSummary: undefined,
    contextPrompt: undefined,
    channelIdentity: { channel: "whatsapp", channelId: "+39", userName: "Paolo" },
    stateBuffer: undefined,
    history: undefined,
    isFirstTurn: true,
    hasOverflow: false,
    droppedMessages: undefined,
    instanceConfig: {} as PipelineContext["instanceConfig"],
    langsmith: undefined,
    userAttachments: undefined,
    incomingSystemMessages: undefined,
    isAutoTaskTurn: false,
    inboundMetadata: undefined,
    ...overrides,
  };
}

describe("buildHookPayload", () => {
  it("should_build_payload_from_channel_identity", () => {
    const payload = buildHookPayload(ctxWith({}), "ciao");
    expect(payload).toEqual({
      instance: { slug: "demo" },
      conversation: { id: "demo:whatsapp:+39" },
      channel: { type: "whatsapp", id: "+39" },
      user: { name: "Paolo" },
      message: { text: "ciao" },
    });
  });

  it("should_include_response_when_text_given", () => {
    const payload = buildHookPayload(ctxWith({}), "ciao", "risposta");
    expect(payload?.response).toEqual({ text: "risposta" });
  });

  it("should_return_undefined_for_auto_task_turns", () => {
    expect(buildHookPayload(ctxWith({ isAutoTaskTurn: true }), "### Task: x")).toBeUndefined();
  });

  it("should_return_undefined_without_channel_identity", () => {
    expect(buildHookPayload(ctxWith({ channelIdentity: undefined }), "x")).toBeUndefined();
  });

  it("should_return_undefined_for_synthetic_channels", () => {
    for (const channel of ["agent", "scheduled", "room"]) {
      const ctx = ctxWith({ channelIdentity: { channel, channelId: "x" } });
      expect(buildHookPayload(ctx, "x")).toBeUndefined();
    }
  });

  it("should_default_user_name_to_empty_string", () => {
    const ctx = ctxWith({ channelIdentity: { channel: "telegram", channelId: "42" } });
    expect(buildHookPayload(ctx, "x")?.user).toEqual({ name: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pipeline-hooks.test.ts -w false`
Expected: FAIL — `buildHookPayload` is not exported (and `isFirstTurn` missing from PipelineContext)

- [ ] **Step 3: Implement the pipeline changes** — all in `pipeline.ts`:

3a. Add imports at the top:

```ts
import { runHooks } from "./hooks/hook-runner.js";
import type { HookEventPayload, HookRunContext } from "./hooks/hook-types.js";
```

3b. Add to `PipelineContext` (after `history`):

```ts
  /** True when no message rows were persisted before this turn (first successful turn). */
  isFirstTurn: boolean;
```

3c. In `preparePipeline`, right after the `Promise.all` destructuring, compute the flag from the PERSISTED rows (NOT the metadata fallback — the OpenAI-compat path passes client-side history that must not suppress `conversation_start`):

```ts
  const isFirstTurn = conversationHistory.length === 0;
```

and add `isFirstTurn,` to the returned object (after `history,`).

3d. Add the two helpers (exported `buildHookPayload` for tests) after the `preparePipeline` function:

```ts
// ---------------------------------------------------------------------------
// Lifecycle hooks — payload + run-context builders
// ---------------------------------------------------------------------------

/**
 * Build the hook event payload, or undefined when hooks must not fire:
 * auto-task turns and synthetic channels (agent/scheduled/room), consistent
 * with state seeding and inbound emits.
 */
export function buildHookPayload(
  ctx: PipelineContext,
  messageText: string,
  responseText?: string,
): HookEventPayload | undefined {
  if (ctx.isAutoTaskTurn || !ctx.channelIdentity) return undefined;
  if (INBOUND_SUPPRESSED_CHANNELS.has(ctx.channelIdentity.channel)) return undefined;
  return {
    instance: { slug: ctx.instanceId },
    conversation: { id: ctx.conversationId },
    channel: { type: ctx.channelIdentity.channel, id: ctx.channelIdentity.channelId },
    user: { name: ctx.channelIdentity.userName ?? "" },
    message: { text: messageText },
    ...(responseText !== undefined ? { response: { text: responseText } } : {}),
  };
}

function buildHookRunContext(ctx: PipelineContext, abortSignal?: AbortSignal): HookRunContext {
  return {
    instanceId: ctx.instanceId,
    conversationId: ctx.conversationId,
    secrets: ctx.instanceConfig.secrets,
    apiKeys: ctx.instanceConfig.apiKeys,
    provider: ctx.instanceConfig.provider,
    state: ctx.stateBuffer?.api(),
    abortSignal,
  };
}
```

3e. Extend `runPipelinePre` with an optional `abortSignal` and the two pre events (hooks run AFTER `contextPrepMs` is measured so hook latency doesn't pollute the context-prep metric):

```ts
export async function runPipelinePre(
  msg: IncomingMessage,
  conversationIdOverride?: string | null,
  abortSignal?: AbortSignal,
): Promise<PipelinePreResult> {
  // Phase 1: Context preparation
  const contextPrepStart = Date.now();
  const ctx = await preparePipeline(msg, conversationIdOverride);
  const contextPrepMs = Date.now() - contextPrepStart;

  // Lifecycle hooks (observe-only, awaited): conversation_start on the first
  // persisted turn, then message_received on every turn — state writes are
  // visible to the supervisor in the same turn.
  const hookPayload = buildHookPayload(ctx, msg.text);
  if (hookPayload) {
    const hookCtx = buildHookRunContext(ctx, abortSignal);
    if (ctx.isFirstTurn) {
      await runHooks("conversation_start", hookPayload, hookCtx);
    }
    await runHooks("message_received", hookPayload, hookCtx);
  }

  return { ctx, contextPrepMs, messageText: msg.text };
}
```

3f. In `runPipelinePost`, right after `const finalText = opts.resultText;` add `response_generated` (before the trace + state flush, so hook state writes ride the turn's commit and total latency stays truthful):

```ts
  // Lifecycle hooks: response_generated precedes outbound delivery on the
  // sync path (the adapter sends only after handleMessage returns) and the
  // state flush below. Streaming caveat: text already reached the client.
  const hookPayload = buildHookPayload(ctx, opts.messageText, finalText);
  const hookCtx = hookPayload ? buildHookRunContext(ctx, opts.abortSignal) : undefined;
  if (hookPayload && hookCtx) {
    await runHooks("response_generated", hookPayload, hookCtx);
  }
```

3g. At the end of `runPipelinePost`, right before `return { finalText };`, add `response_sent`:

```ts
  // Lifecycle hooks: response_sent fires once the turn is finalized and handed
  // to the channel (the pipeline never observes physical delivery — see the
  // hooks design doc). The main flush already ran, so persist any state these
  // hooks wrote with a second flush (no-op when nothing changed).
  if (hookPayload && hookCtx) {
    await runHooks("response_sent", hookPayload, hookCtx);
    if (ctx.stateBuffer) {
      try {
        await ctx.stateBuffer.flush();
      } catch (err) {
        console.error(`Failed to flush hook state for ${ctx.conversationId}:`, err);
      }
    }
  }
```

3h. In `index.ts` thread the signal into both call sites:
- line ~187 (handleMessage): `const pre = await runPipelinePre(msg, taskConversationOverride, abortSignal);`
- line ~255 (handleMessageStream): `const pre = await runPipelinePre(msg, undefined, abortSignal);`

- [ ] **Step 4: Run the new test + the full unit suite to catch regressions**

Run: `npx vitest run src/pipeline-hooks.test.ts -w false` → PASS (6 tests)
Run: `npm run typecheck -w @polyant/engine` → exit 0
Run: `npm run test:unit -w @polyant/engine` → PASS (pre-existing suites green)

- [ ] **Step 5: Commit**

`feat(hooks): wire lifecycle hooks into the message pipeline`

---

### Task 8: Validators + Management API controller

**Files:**
- Create: `packages/engine/src/hooks/hooks.validators.ts`
- Create: `packages/engine/src/server/hooks/instance-hooks.controller.ts`
- Modify: `packages/engine/src/server/server.module.ts`
- Test: `packages/engine/src/hooks/hooks.validators.test.ts`

- [ ] **Step 1: Write the failing validator tests**

```ts
// packages/engine/src/hooks/hooks.validators.test.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";

const { registryMock } = vi.hoisted(() => ({ registryMock: new Map<string, unknown>() }));
vi.mock("../agents/tools/registry.js", () => ({
  getToolRegistry: () => registryMock,
}));

import { createHookSchema, updateHookSchema, validateHookTool } from "./hooks.validators.js";

describe("createHookSchema", () => {
  const valid = {
    event: "conversation_start",
    actionConfig: { toolName: "lookup", args: { q: "{{channel.id}}" } },
  };

  it("should_apply_defaults_when_optional_fields_omitted", () => {
    const parsed = createHookSchema.parse(valid);
    expect(parsed).toMatchObject({
      actionType: "tool",
      enabled: true,
      position: 0,
      timeoutMs: 10_000,
    });
  });

  it("should_reject_unknown_event", () => {
    expect(createHookSchema.safeParse({ ...valid, event: "conversation_idle" }).success).toBe(false);
  });

  it("should_reject_out_of_bounds_timeout", () => {
    expect(createHookSchema.safeParse({ ...valid, timeoutMs: 500 }).success).toBe(false);
    expect(createHookSchema.safeParse({ ...valid, timeoutMs: 60_000 }).success).toBe(false);
  });

  it("should_reject_empty_tool_name", () => {
    expect(
      createHookSchema.safeParse({ ...valid, actionConfig: { toolName: "", args: {} } }).success,
    ).toBe(false);
  });

  it("should_accept_partial_updates", () => {
    expect(updateHookSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateHookSchema.safeParse({}).success).toBe(true);
  });
});

describe("validateHookTool", () => {
  it("should_flag_unregistered_and_meta_tools", () => {
    registryMock.clear();
    registryMock.set("ok", { name: "ok" });
    registryMock.set("meta", { name: "meta", metaTool: true });
    expect(validateHookTool("ok")).toBeNull();
    expect(validateHookTool("nope")).toMatch(/not registered/);
    expect(validateHookTool("meta")).toMatch(/meta-tool/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/hooks.validators.test.ts -w false`
Expected: FAIL — `Cannot find module './hooks.validators.js'`

- [ ] **Step 3: Implement the validators**

```ts
// packages/engine/src/hooks/hooks.validators.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { HOOK_EVENTS, HOOK_ACTION_TYPES } from "./hook-types.js";
import { getToolRegistry } from "../agents/tools/registry.js";

export const hookActionConfigSchema = z.object({
  toolName: z.string().min(1, "toolName is required"),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const createHookSchema = z.object({
  event: z.enum(HOOK_EVENTS),
  actionType: z.enum(HOOK_ACTION_TYPES).default("tool"),
  actionConfig: hookActionConfigSchema,
  enabled: z.boolean().default(true),
  position: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
});

export const updateHookSchema = createHookSchema.partial();

/** Error message when the tool cannot back a hook, or null when valid. */
export function validateHookTool(toolName: string): string | null {
  const def = getToolRegistry().get(toolName);
  if (!def) return `Tool "${toolName}" is not registered`;
  if (def.metaTool) return `Tool "${toolName}" is a meta-tool and cannot be used in hooks`;
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/hooks.validators.test.ts -w false`
Expected: PASS (7 tests)

- [ ] **Step 5: Implement the controller** (pure HTTP bridge; instance-scoped WHERE via store; no constructor deps so the `@Inject` lint rule is satisfied trivially)

```ts
// packages/engine/src/server/hooks/instance-hooks.controller.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import {
  listHooks,
  createHook,
  updateHook,
  deleteHook,
  invalidateHooksCache,
} from "../../hooks/hooks.store.js";
import {
  createHookSchema,
  updateHookSchema,
  validateHookTool,
} from "../../hooks/hooks.validators.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { asInstanceSlug } from "../../instances/identifiers.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api/instances/:slug/hooks")
export class InstanceHooksController {
  @Get()
  async list(@Param("slug") slug: string) {
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");
    return { hooks: await listHooks(instanceId) };
  }

  @Post()
  async create(@Param("slug") slug: string, @Body() body: unknown) {
    const parsed = createHookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }
    const toolError = validateHookTool(parsed.data.actionConfig.toolName);
    if (toolError) throw new BadRequestException(toolError);

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const hook = await createHook(instanceId, parsed.data);
    invalidateHooksCache(asInstanceSlug(slug));
    return { hook };
  }

  @Patch(":id")
  async update(@Param("slug") slug: string, @Param("id") id: string, @Body() body: unknown) {
    if (!UUID_RE.test(id)) throw new BadRequestException("Invalid hook id");
    const parsed = updateHookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join(", "));
    }
    if (parsed.data.actionConfig) {
      const toolError = validateHookTool(parsed.data.actionConfig.toolName);
      if (toolError) throw new BadRequestException(toolError);
    }

    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const hook = await updateHook(instanceId, id, parsed.data);
    if (!hook) throw new NotFoundException("Hook not found");
    invalidateHooksCache(asInstanceSlug(slug));
    return { hook };
  }

  @Delete(":id")
  async remove(@Param("slug") slug: string, @Param("id") id: string) {
    if (!UUID_RE.test(id)) throw new BadRequestException("Invalid hook id");
    const instanceId = await resolveInstanceId(asInstanceSlug(slug));
    if (!instanceId) throw new NotFoundException("Instance not found");

    const deleted = await deleteHook(instanceId, id);
    if (!deleted) throw new NotFoundException("Hook not found");
    invalidateHooksCache(asInstanceSlug(slug));
    return { deleted: true };
  }
}
```

- [ ] **Step 6: Register the controller** — in `server.module.ts` add the import after the `RoomController` import:

```ts
import { InstanceHooksController } from "./hooks/instance-hooks.controller.js";
```

and add `InstanceHooksController,` to the `controllers` array (after `RoomController,`).

- [ ] **Step 7: Verify typecheck + lint**

Run: `npm run typecheck -w @polyant/engine && npm run lint -w @polyant/engine`
Expected: exit 0 (no `@Inject` violations — controller has no constructor)

- [ ] **Step 8: Commit**

`feat(hooks): add management API for instance hooks`

---

### Task 9: Web API client types + functions

**Files:**
- Modify: `packages/web/src/lib/api-types.ts` (append the type)
- Modify: `packages/web/src/lib/api.ts` (re-export type + `hooks` section in the `api` object)

- [ ] **Step 1: Add the type to `api-types.ts`** (append near `EventSource`/`EventDefinition`):

```ts
export type HookEvent =
  | "conversation_start"
  | "message_received"
  | "response_generated"
  | "response_sent";

export interface InstanceHook {
  id: string;
  event: HookEvent;
  actionType: "tool";
  actionConfig: { toolName: string; args: Record<string, unknown> };
  enabled: boolean;
  position: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Wire into `api.ts`** — add `HookEvent`, `InstanceHook` to BOTH the `export type {...}` re-export list and the internal `import type {...}` list. Then add a `hooks` section to the `api` object (after `scheduledTasks`):

```ts
  hooks: {
    list: (slug: string) =>
      request<{ hooks: InstanceHook[] }>(
        `/api/instances/${encodeURIComponent(slug)}/hooks`,
      ),
    create: (
      slug: string,
      data: {
        event: HookEvent;
        actionType?: "tool";
        actionConfig: { toolName: string; args: Record<string, unknown> };
        enabled?: boolean;
        position?: number;
        timeoutMs?: number;
      },
    ) =>
      request<{ hook: InstanceHook }>(
        `/api/instances/${encodeURIComponent(slug)}/hooks`,
        { method: "POST", body: JSON.stringify(data) },
      ),
    update: (
      slug: string,
      id: string,
      data: {
        event?: HookEvent;
        actionConfig?: { toolName: string; args: Record<string, unknown> };
        enabled?: boolean;
        position?: number;
        timeoutMs?: number;
      },
    ) =>
      request<{ hook: InstanceHook }>(
        `/api/instances/${encodeURIComponent(slug)}/hooks/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(data) },
      ),
    delete: (slug: string, id: string) =>
      request<{ deleted: boolean }>(
        `/api/instances/${encodeURIComponent(slug)}/hooks/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },
```

(Match the exact local helper name used in `api.ts` for HTTP calls — it is `request` per the `scheduledTasks` section; keep the surrounding style.)

- [ ] **Step 3: Verify web typecheck**

Run: `npm run typecheck -w @polyant/web`
Expected: exit 0

- [ ] **Step 4: Commit**

`feat(web): add hooks API client`

---

### Task 10: Admin UI — Hooks tab

**Files:**
- Create: `packages/web/src/app/(admin)/instances/[slug]/hooks-tab.tsx`
- Modify: `packages/web/src/app/(admin)/instances/[slug]/page.tsx` (import, TabsTrigger, TabsContent)
- Modify: `packages/web/src/lib/i18n/locales/en.json` + `it.json`

- [ ] **Step 1: Create the tab component**

```tsx
// packages/web/src/app/(admin)/instances/[slug]/hooks-tab.tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, getUserErrorMessage, type HookEvent, type InstanceHook, type ToolInfo } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

const HOOK_EVENTS: HookEvent[] = [
  "conversation_start",
  "message_received",
  "response_generated",
  "response_sent",
];

const PLACEHOLDERS = [
  "{{instance.slug}}",
  "{{conversation.id}}",
  "{{channel.type}}",
  "{{channel.id}}",
  "{{user.name}}",
  "{{message.text}}",
  "{{response.text}}",
];

interface Props {
  slug: string;
}

interface FormState {
  event: HookEvent;
  toolName: string;
  argsText: string;
  timeoutMs: number;
  position: number;
}

const EMPTY_FORM: FormState = {
  event: "conversation_start",
  toolName: "",
  argsText: "{}",
  timeoutMs: 10000,
  position: 0,
};

export function HooksTab({ slug }: Props) {
  const { t } = useI18n();
  const [hooks, setHooks] = useState<InstanceHook[]>([]);
  const [catalog, setCatalog] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<InstanceHook | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<InstanceHook | null>(null);

  const load = useCallback(async () => {
    try {
      const [hooksRes, catalogRes] = await Promise.all([
        api.hooks.list(slug),
        api.tools.catalog(),
      ]);
      setHooks(hooksRes.hooks);
      setCatalog(catalogRes.tools);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (hook: InstanceHook) => {
    setEditing(hook);
    setForm({
      event: hook.event,
      toolName: hook.actionConfig.toolName,
      argsText: JSON.stringify(hook.actionConfig.args, null, 2),
      timeoutMs: hook.timeoutMs,
      position: hook.position,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(form.argsText || "{}");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("not an object");
    } catch {
      toast.error(t("hooks.invalidArgsJson"));
      return;
    }
    if (!form.toolName) {
      toast.error(t("hooks.toolRequired"));
      return;
    }
    setSaving(true);
    try {
      const data = {
        event: form.event,
        actionConfig: { toolName: form.toolName, args },
        timeoutMs: form.timeoutMs,
        position: form.position,
      };
      if (editing) {
        await api.hooks.update(slug, editing.id, data);
      } else {
        await api.hooks.create(slug, data);
      }
      toast.success(t("hooks.saved"));
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (hook: InstanceHook, enabled: boolean) => {
    setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, enabled } : h)));
    try {
      await api.hooks.update(slug, hook.id, { enabled });
    } catch (err) {
      setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, enabled: hook.enabled } : h)));
      toast.error(getUserErrorMessage(err, t("hooks.saveFailed")));
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api.hooks.delete(slug, deleting.id);
      toast.success(t("hooks.deleted"));
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.deleteFailed")));
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const knownTools = new Set(catalog.map((tool) => tool.name));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-medium">{t("hooks.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("hooks.description")}</p>
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          {t("hooks.add")}
        </Button>
      </div>

      {hooks.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("hooks.empty")}
        </p>
      ) : (
        <div className="space-y-6">
          {HOOK_EVENTS.map((event) => {
            const eventHooks = hooks.filter((h) => h.event === event);
            if (eventHooks.length === 0) return null;
            return (
              <div key={event}>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                  {t(`hooks.events.${event}`)}
                </h3>
                <div className="divide-y rounded-md border">
                  {eventHooks.map((hook) => (
                    <div key={hook.id} className="flex items-center gap-3 p-3">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {hook.actionConfig.toolName}
                      </code>
                      {!knownTools.has(hook.actionConfig.toolName) && (
                        <Badge variant="destructive">{t("hooks.unknownTool")}</Badge>
                      )}
                      <Badge variant="secondary">{hook.timeoutMs / 1000}s</Badge>
                      <span className="text-xs text-muted-foreground">
                        {t("hooks.position")} {hook.position}
                      </span>
                      <div className="ml-auto flex items-center gap-2">
                        <Switch
                          checked={hook.enabled}
                          onCheckedChange={(v) => handleToggle(hook, v)}
                        />
                        <Button variant="ghost" size="sm" onClick={() => openEdit(hook)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setDeleting(hook)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? t("hooks.editTitle") : t("hooks.createTitle")}</DialogTitle>
            <DialogDescription>{t("hooks.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("hooks.event")}</Label>
              <Select
                value={form.event}
                onValueChange={(v) => setForm((f) => ({ ...f, event: v as HookEvent }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_EVENTS.map((event) => (
                    <SelectItem key={event} value={event}>
                      {t(`hooks.events.${event}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("hooks.tool")}</Label>
              <Select
                value={form.toolName || undefined}
                onValueChange={(v) => setForm((f) => ({ ...f, toolName: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("hooks.toolPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {catalog.map((tool) => (
                    <SelectItem key={tool.name} value={tool.name}>
                      {tool.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("hooks.args")}</Label>
              <Textarea
                value={form.argsText}
                onChange={(e) => setForm((f) => ({ ...f, argsText: e.target.value }))}
                rows={5}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t("hooks.argsHint")} {PLACEHOLDERS.join(" ")}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("hooks.timeout")}</Label>
                <Input
                  type="number"
                  min={1000}
                  max={30000}
                  step={1000}
                  value={form.timeoutMs}
                  onChange={(e) => setForm((f) => ({ ...f, timeoutMs: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("hooks.position")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.position}
                  onChange={(e) => setForm((f) => ({ ...f, position: Number(e.target.value) }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("hooks.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("hooks.deleteDescription", { tool: deleting?.actionConfig.toolName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

(Verify `api.tools.catalog()` is the actual catalog function name at `packages/web/src/lib/api.ts:250`; adjust if it differs.)

- [ ] **Step 2: Register the tab in `page.tsx`**

Add the import after `import { RoomTab } ...`:

```tsx
import { HooksTab } from "./hooks-tab";
```

Add the trigger after the `room` TabsTrigger (line ~215):

```tsx
          <TabsTrigger value="hooks">{t("instances.detail.tabHooks")}</TabsTrigger>
```

Add the content after the `room` TabsContent (line ~260):

```tsx
        <TabsContent value="hooks" className="mt-6">
          <HooksTab slug={instance.slug} />
        </TabsContent>
```

- [ ] **Step 3: Add i18n keys**

In `packages/web/src/lib/i18n/locales/en.json`: add `"tabHooks": "Hooks"` inside `instances.detail`, and a top-level `"hooks"` section (match the file's existing nesting style):

```json
  "hooks": {
    "title": "Lifecycle hooks",
    "description": "Run a tool automatically when a conversation event fires. Hooks are observe-only: they never modify the message or the reply.",
    "add": "Add hook",
    "empty": "No hooks configured. Add one to run a tool on a conversation event.",
    "event": "Event",
    "tool": "Tool",
    "toolPlaceholder": "Select a tool",
    "toolRequired": "Select a tool",
    "unknownTool": "Not available",
    "args": "Arguments (JSON template)",
    "argsHint": "Available placeholders:",
    "invalidArgsJson": "Arguments must be a valid JSON object",
    "timeout": "Timeout (ms)",
    "position": "Order",
    "createTitle": "Add hook",
    "editTitle": "Edit hook",
    "dialogDescription": "The tool runs with these arguments when the event fires. {{path}} placeholders are filled from the event data.",
    "saved": "Hook saved",
    "saveFailed": "Failed to save hook",
    "deleted": "Hook deleted",
    "deleteFailed": "Failed to delete hook",
    "deleteTitle": "Delete hook?",
    "deleteDescription": "The {tool} hook will no longer run. This cannot be undone.",
    "loadFailed": "Failed to load hooks",
    "events": {
      "conversation_start": "Conversation start",
      "message_received": "Message received",
      "response_generated": "Response generated",
      "response_sent": "Response sent"
    }
  }
```

In `it.json`, same keys translated:

```json
  "hooks": {
    "title": "Hook del ciclo di vita",
    "description": "Esegui automaticamente un tool quando si verifica un evento della conversazione. Gli hook sono solo osservativi: non modificano mai il messaggio o la risposta.",
    "add": "Aggiungi hook",
    "empty": "Nessun hook configurato. Aggiungine uno per eseguire un tool su un evento della conversazione.",
    "event": "Evento",
    "tool": "Tool",
    "toolPlaceholder": "Seleziona un tool",
    "toolRequired": "Seleziona un tool",
    "unknownTool": "Non disponibile",
    "args": "Argomenti (template JSON)",
    "argsHint": "Placeholder disponibili:",
    "invalidArgsJson": "Gli argomenti devono essere un oggetto JSON valido",
    "timeout": "Timeout (ms)",
    "position": "Ordine",
    "createTitle": "Aggiungi hook",
    "editTitle": "Modifica hook",
    "dialogDescription": "Il tool viene eseguito con questi argomenti quando scatta l'evento. I placeholder {{path}} vengono riempiti dai dati dell'evento.",
    "saved": "Hook salvato",
    "saveFailed": "Salvataggio hook non riuscito",
    "deleted": "Hook eliminato",
    "deleteFailed": "Eliminazione hook non riuscita",
    "deleteTitle": "Eliminare l'hook?",
    "deleteDescription": "L'hook {tool} non verrà più eseguito. L'operazione non è reversibile.",
    "loadFailed": "Caricamento hook non riuscito",
    "events": {
      "conversation_start": "Inizio conversazione",
      "message_received": "Messaggio ricevuto",
      "response_generated": "Risposta generata",
      "response_sent": "Risposta inviata"
    }
  }
```

And `"tabHooks": "Hook"` inside `instances.detail` in `it.json`.

- [ ] **Step 4: Verify typecheck + lint + build**

Run: `npm run typecheck -w @polyant/web && npm run lint -w @polyant/web`
Expected: exit 0 (react-compiler rules are warn-level)

- [ ] **Step 5: Commit**

`feat(web): add hooks tab to instance admin page`

---

### Task 11: Documentation + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Add to the Instance Configuration table:

```markdown
| Hooks | `instance_hooks` | Lifecycle event → action (v1: run tool), template args, per-event ordering |
```

Add to Key Conventions (after the conversation-state bullet):

```markdown
- **Conversation lifecycle hooks** (`packages/engine/src/hooks/`): per-instance, DB-configured (event → action) pairs run by `runHooks()` at four fixed pipeline points — `conversation_start` (first turn with empty persisted history — abort-safe vs the coordinator's cancel-and-restart), `message_received` (pre-LLM), `response_generated` (post-LLM, pre-flush), `response_sent` (end of pipeline post; semantics = "handed to channel", NOT delivered). Hooks are observe-only, ALL awaited (sequential, `position` order, per-hook timeout 1–30 s, default 10 s) and log-and-continue — a failing hook never blocks the reply. v1 action type is `tool`: a registered non-meta tool executed with statically-configured args whose `{{path}}` placeholders are rendered from the server-built event payload (never LLM output). Hook tools receive the turn's `ToolContext` including `ctx.state`; pre-event writes are visible to the supervisor in the same turn and ride the commit-on-success flush (`response_sent` writes get a second flush). Hooks bypass `instance_tools` enablement (deterministic admin config, like harness tools), skip auto-tasks + synthetic channels (`agent`/`scheduled`/`room`), and audit outcome only (never rendered args — PII). Extensible via `action_type` + executor registry in `hook-runner.ts`. Managed via `GET/POST/PATCH/DELETE /api/instances/:slug/hooks` + web "Hooks" tab. Design: `docs/superpowers/specs/2026-06-10-hook-system-design.md`
```

Add `│   │   │   ├── hooks/                # Conversation lifecycle hooks (event → tool action)` to the directory tree (after `crypto/`), `- **Hooks**: \`GET/POST/PATCH/DELETE /api/instances/:slug/hooks\`` to the Management API list, and `- Hooks tab (lifecycle event → tool action with template args)` to the Admin Panel list.

- [ ] **Step 2: Full verification**

Run from repo root:
- `npm run typecheck` → exit 0
- `npm run lint` → exit 0
- `npm test` → all suites pass (hooks integration suite needs the DB up to actually run)

- [ ] **Step 3: Commit**

`docs: document conversation lifecycle hooks conventions`

---

## Self-review notes

- **Spec coverage:** data model → Task 2/3; template payloads → Task 1; pipeline semantics incl. abort-safe `conversation_start`, sync ordering, second flush for `response_sent` → Task 7; runner (sequential, timeout, log-and-continue, audit-no-args, metaTool exclusion, instance_tools bypass) → Tasks 5/6; API → Task 8; UI incl. misconfiguration badge (`unknownTool`) → Tasks 9/10; testing → every task; CLAUDE.md → Task 11.
- **Type consistency:** `InstanceHookRow.actionConfig: HookActionConfig` is used by store, executor, runner, controller and mirrored as `InstanceHook.actionConfig` in the web client. `HookEvent`/`HOOK_EVENTS` shared engine-side; web duplicates the literal union (packages don't share types).
- **Known judgment calls:** `requiredSecrets` are NOT pre-checked by the hook executor (unlike `buildTools`) — a misconfigured tool fails at runtime and is logged/audited, which the spec explicitly allows; the UI flags tools missing from the catalog. `validateHookTool` lives in `hooks.validators.ts` (imports the registry) to keep the controller a pure bridge.
