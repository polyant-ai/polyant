# GDPR Opt-Out ("STOP / START") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an end user stop receiving any message from an instance by sending a keyword (e.g. `STOP`) and resume with a counter-keyword (e.g. `START`), enforced deterministically per contact, configurable per instance.

**Architecture:** A deterministic gate runs at two chokepoints — a pre-LLM inbound gate (`handleMessage`/`handleMessageStream`) that short-circuits opted-out contacts, and an outbound suppression in `channelManager.sendOutbound`/`sendOutboundTemplate` that blocks proactive sends. Opt-out state is persisted per `(instanceId, channelType, channelId)` in a new `contact_optouts` table. Config lives as columns on `instances`. The LLM is never the enforcer; the keyword is also injected into the prompt purely as informational context.

**Tech Stack:** TypeScript (ESM), NestJS 11, Drizzle ORM + PostgreSQL, Vitest, Next.js 16 (admin web).

**Spec:** `docs/superpowers/specs/2026-06-11-gdpr-optout-design.md`

**Conventions (apply to every task):**
- ESM: relative imports MUST end in `.js`. Named exports only.
- Files in kebab-case. Branded ids: `InstanceSlug` (slug text) vs `InstanceUuid` (uuid FK) — convert only via `resolveInstanceId`/`asInstanceUuid`.
- NestJS constructor params MUST use explicit `@Inject(...)` (tsx has no `emitDecoratorMetadata`).
- Run a single test file with: `npm test -w @polyant/engine -- <pattern>` (appends a filename filter to `vitest run`).
- Commits: end the message body with `Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>` and `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Use `git commit -F <file>` (multi-line `-m` corrupts newlines in this shell).

---

## File Structure

**New (engine):**
- `packages/engine/src/optout/optout.schema.ts` — `contact_optouts` Drizzle table.
- `packages/engine/src/optout/optout.types.ts` — `OptoutConfig`, `OptoutStatus`, `OptoutAction`.
- `packages/engine/src/optout/optout.guard.ts` — pure `evaluateOptout`.
- `packages/engine/src/optout/optout.guard.test.ts` — unit tests for the guard.
- `packages/engine/src/optout/contact-optouts.store.ts` — status lookup/set/list + cache.
- `packages/engine/src/optout/contact-optouts.store.test.ts` — store unit tests.
- `packages/engine/src/optout/optout-gate.ts` — `runOptoutGate` + conversation-persistence helper.
- `packages/engine/src/optout/optout-gate.test.ts` — gate unit tests.
- `packages/engine/src/optout/index.ts` — barrel.
- `packages/engine/src/server/optouts/optouts.controller.ts` — list + manual override endpoints.
- `packages/engine/src/server/optouts/optouts.module.ts` — NestJS module.
- `packages/engine/src/database/migrations/0049_add_gdpr_optout.sql` — hand-written migration.

**Modified (engine):**
- `packages/engine/src/instances/schema.ts` — 6 opt-out columns.
- `packages/engine/src/instances/store.ts` — `Instance` interface + `updateInstance` param type.
- `packages/engine/src/instances/config-resolver.ts` — `optout` sub-object on `InstanceConfig`.
- `packages/engine/src/index.ts` — inbound gate wiring.
- `packages/engine/src/channels/channel-manager.ts` — outbound suppression + coordinator `skipOptoutCheck`.
- `packages/engine/src/agents/supervisor/index.ts` — thread opt-out hint into prompt options.
- `packages/engine/src/agents/supervisor/prompt.ts` — render informational opt-out section.
- `packages/engine/src/server/instances/instances.controller.ts` — PATCH DTO + GET DTO fields.
- `packages/engine/src/server/main.ts` (or the root module) — register `OptoutsModule`.
- `packages/engine/drizzle.config.ts` — register the new schema file.
- `packages/engine/src/database/migrations/meta/_journal.json` — journal entry for 0049.

**Modified (web):**
- `packages/web/src/lib/api.ts` + `packages/web/src/lib/api-types.ts` — opt-out types + client methods.
- `packages/web/src/app/(admin)/instances/[slug]/privacy-tab.tsx` — new tab (config + contacts).
- `packages/web/src/app/(admin)/instances/[slug]/page.tsx` — register the tab.
- `packages/web/src/lib/i18n/*` — Italian/English strings.

---

## Phase 1 — Data model & migration

### Task 1: Add opt-out config columns to `instances`

**Files:**
- Modify: `packages/engine/src/instances/schema.ts`
- Modify: `packages/engine/src/instances/store.ts:12-43` (Instance interface), `:118-128` (updateInstance param)

- [ ] **Step 1: Add columns to the schema**

In `packages/engine/src/instances/schema.ts`, change the import line to include `jsonb`:

```ts
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
```

Then add these fields inside the `instances` table object, right after the `debugEnabled` column (line 37):

```ts
  /**
   * GDPR opt-out: when enabled, an end user who sends one of `optoutStopKeywords`
   * is recorded as opted-out (per contact, in `contact_optouts`) and receives no
   * further messages until they send one of `optoutResumeKeywords`. Enforcement is
   * deterministic (pre-LLM gate + outbound suppression) — never the LLM.
   */
  optoutEnabled: boolean("optout_enabled").notNull().default(false),
  optoutStopKeywords: jsonb("optout_stop_keywords").$type<string[]>().notNull().default(["STOP"]),
  optoutResumeKeywords: jsonb("optout_resume_keywords").$type<string[]>().notNull().default(["START"]),
  /** Sent once when a contact opts out. NULL/empty = no confirmation message. */
  optoutClosingMessage: text("optout_closing_message"),
  /** Sent once when a contact resumes. NULL/empty = no confirmation message. */
  optoutResumeMessage: text("optout_resume_message"),
  /** When true, an informational opt-out hint is injected into the supervisor prompt. */
  optoutInjectPromptHint: boolean("optout_inject_prompt_hint").notNull().default(true),
```

- [ ] **Step 2: Extend the `Instance` interface**

In `packages/engine/src/instances/store.ts`, add to the `Instance` interface (after `debugEnabled`, line 38):

```ts
  /** GDPR opt-out feature toggle. */
  optoutEnabled: boolean;
  optoutStopKeywords: string[];
  optoutResumeKeywords: string[];
  optoutClosingMessage: string | null;
  optoutResumeMessage: string | null;
  optoutInjectPromptHint: boolean;
```

- [ ] **Step 3: Extend the `updateInstance` data param**

In `packages/engine/src/instances/store.ts:118-120`, append these optional fields to the `data` parameter type (inside the existing inline object type, before the closing `}`):

```ts
  optoutEnabled?: boolean; optoutStopKeywords?: string[]; optoutResumeKeywords?: string[]; optoutClosingMessage?: string | null; optoutResumeMessage?: string | null; optoutInjectPromptHint?: boolean;
```

(`toInstance` spreads the row, so the new columns flow through automatically; no change needed there.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/instances/schema.ts packages/engine/src/instances/store.ts
git commit -F /tmp/commit-optout-1.txt
```
where `/tmp/commit-optout-1.txt` contains:
```
feat(optout): add GDPR opt-out config columns to instances

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 2: Create the `contact_optouts` table + migration

**Files:**
- Create: `packages/engine/src/optout/optout.schema.ts`
- Create: `packages/engine/src/database/migrations/0049_add_gdpr_optout.sql`
- Modify: `packages/engine/src/database/migrations/meta/_journal.json`
- Modify: `packages/engine/drizzle.config.ts`

- [ ] **Step 1: Write the Drizzle schema**

Create `packages/engine/src/optout/optout.schema.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { pgTable, uuid, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { instances } from "../instances/schema.js";

/**
 * Per-contact opt-out state. One row per contact that has ever interacted with
 * the opt-out mechanism. Absence of a row = subscribed (default).
 *
 * Keyed by (instanceId, channelType, channelId) so opt-out follows the contact
 * across every future conversation and Room cycle. The uuid FK to instances has
 * onDelete cascade, so rows drop on instance delete — but NOT on conversation
 * delete (a deleted conversation must never re-subscribe a contact).
 */
export const contactOptouts = pgTable(
  "contact_optouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    channelType: text("channel_type").notNull(),
    channelId: text("channel_id").notNull(),
    /** "opted_out" | "opted_in" */
    status: text("status").notNull(),
    /** Origin of the last transition: "user" (keyword) | "admin" (manual override). */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("contact_optouts_instance_channel_uq").on(t.instanceId, t.channelType, t.channelId),
    index("contact_optouts_instance_status_idx").on(t.instanceId, t.status),
  ],
);
```

- [ ] **Step 2: Write the migration SQL**

Create `packages/engine/src/database/migrations/0049_add_gdpr_optout.sql`:

```sql
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_stop_keywords" jsonb DEFAULT '["STOP"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_resume_keywords" jsonb DEFAULT '["START"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_closing_message" text;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_resume_message" text;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_inject_prompt_hint" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_optouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" uuid NOT NULL,
  "channel_type" text NOT NULL,
  "channel_id" text NOT NULL,
  "status" text NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contact_optouts_instance_channel_uq" UNIQUE("instance_id","channel_type","channel_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "contact_optouts" ADD CONSTRAINT "contact_optouts_instance_id_instances_id_fk"
    FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_optouts_instance_status_idx" ON "contact_optouts" ("instance_id","status");
```

- [ ] **Step 3: Register the migration in the journal**

In `packages/engine/src/database/migrations/meta/_journal.json`, append a new entry to the `entries` array (after the `idx: 44` entry):

```json
    ,{
      "idx": 45,
      "version": "7",
      "when": 1779926400000,
      "tag": "0049_add_gdpr_optout",
      "breakpoints": true
    }
```

(Ensure valid JSON — the new object is inside the `entries` array, before the closing `]`.)

- [ ] **Step 4: Register the schema file in drizzle.config**

In `packages/engine/drizzle.config.ts`, add to the `schema` array:

```ts
    "./src/optout/optout.schema.ts",
```

- [ ] **Step 5: Apply the migration**

Run: `npm run db:migrate -w @polyant/engine`
Expected: "Migrations applied successfully." (requires `docker compose up -d` postgres running).

- [ ] **Step 6: Verify the table exists**

Run: `npm run db:migrate -w @polyant/engine` again (idempotent — IF NOT EXISTS).
Expected: still succeeds, no error.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/optout/optout.schema.ts packages/engine/src/database/migrations/0049_add_gdpr_optout.sql packages/engine/src/database/migrations/meta/_journal.json packages/engine/drizzle.config.ts
git commit -F /tmp/commit-optout-2.txt
```
Commit body:
```
feat(optout): add contact_optouts table and migration

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 2 — Pure guard (TDD)

### Task 3: `evaluateOptout` pure function

**Files:**
- Create: `packages/engine/src/optout/optout.types.ts`
- Create: `packages/engine/src/optout/optout.guard.ts`
- Test: `packages/engine/src/optout/optout.guard.test.ts`

- [ ] **Step 1: Write the types**

Create `packages/engine/src/optout/optout.types.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

export type OptoutStatus = "opted_out" | "opted_in";

/** Per-instance opt-out configuration (resolved from the instances row). */
export interface OptoutConfig {
  enabled: boolean;
  stopKeywords: string[];
  resumeKeywords: string[];
  closingMessage: string | null;
  resumeMessage: string | null;
  injectPromptHint: boolean;
}

/** The action the inbound gate must take for the current message. */
export type OptoutAction =
  | { kind: "stop"; reply: string | null }
  | { kind: "resume"; reply: string | null }
  | { kind: "blocked_silent" }
  | { kind: "pass" };
```

- [ ] **Step 2: Write the failing test**

Create `packages/engine/src/optout/optout.guard.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { evaluateOptout } from "./optout.guard.js";
import type { OptoutConfig } from "./optout.types.js";

const cfg: OptoutConfig = {
  enabled: true,
  stopKeywords: ["STOP"],
  resumeKeywords: ["START"],
  closingMessage: "You have been unsubscribed.",
  resumeMessage: "Welcome back.",
  injectPromptHint: true,
};

describe("evaluateOptout", () => {
  it("passes through when the feature is disabled", () => {
    const r = evaluateOptout({ config: { ...cfg, enabled: false }, currentStatus: "opted_in", messageText: "STOP" });
    expect(r).toEqual({ kind: "pass" });
  });

  it("opts out on an exact stop keyword (case/space-insensitive)", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_in", messageText: "  stop " });
    expect(r).toEqual({ kind: "stop", reply: "You have been unsubscribed." });
  });

  it("does NOT opt out when the keyword is a substring of a longer message", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_in", messageText: "please don't stop now" });
    expect(r).toEqual({ kind: "pass" });
  });

  it("resumes on an exact resume keyword when opted out", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_out", messageText: "start" });
    expect(r).toEqual({ kind: "resume", reply: "Welcome back." });
  });

  it("stays silent for any other message while opted out", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_out", messageText: "hello?" });
    expect(r).toEqual({ kind: "blocked_silent" });
  });

  it("is idempotent: a repeated stop keyword while opted out is silent (no second confirmation)", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_out", messageText: "STOP" });
    expect(r).toEqual({ kind: "blocked_silent" });
  });

  it("treats a resume keyword while already subscribed as a normal message", () => {
    const r = evaluateOptout({ config: cfg, currentStatus: "opted_in", messageText: "START" });
    expect(r).toEqual({ kind: "pass" });
  });

  it("supports multiple stop keywords", () => {
    const r = evaluateOptout({ config: { ...cfg, stopKeywords: ["STOP", "UNSUBSCRIBE"] }, currentStatus: "opted_in", messageText: "unsubscribe" });
    expect(r).toEqual({ kind: "stop", reply: "You have been unsubscribed." });
  });

  it("returns null reply when no closing message is configured", () => {
    const r = evaluateOptout({ config: { ...cfg, closingMessage: null }, currentStatus: "opted_in", messageText: "STOP" });
    expect(r).toEqual({ kind: "stop", reply: null });
  });
});
```

- [ ] **Step 2b: Run the test to verify it fails**

Run: `npm test -w @polyant/engine -- optout.guard`
Expected: FAIL — `evaluateOptout` is not exported / file missing.

- [ ] **Step 3: Implement the guard**

Create `packages/engine/src/optout/optout.guard.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OptoutAction, OptoutConfig, OptoutStatus } from "./optout.types.js";

function matches(keywords: string[], normalized: string): boolean {
  return keywords.some((k) => k.trim().toLowerCase() === normalized);
}

/**
 * Pure decision function for the opt-out inbound gate. No I/O.
 *
 * Precedence: when already opted out, a resume keyword wins (re-enable) and
 * everything else (including a repeated stop keyword) is silent. When subscribed,
 * a stop keyword opts out and everything else (including a resume keyword) passes.
 */
export function evaluateOptout(input: {
  config: OptoutConfig;
  currentStatus: OptoutStatus;
  messageText: string;
}): OptoutAction {
  const { config, currentStatus, messageText } = input;
  if (!config.enabled) return { kind: "pass" };

  const normalized = messageText.trim().toLowerCase();

  if (currentStatus === "opted_out") {
    if (matches(config.resumeKeywords, normalized)) {
      return { kind: "resume", reply: config.resumeMessage ?? null };
    }
    return { kind: "blocked_silent" };
  }

  // currentStatus === "opted_in"
  if (matches(config.stopKeywords, normalized)) {
    return { kind: "stop", reply: config.closingMessage ?? null };
  }
  return { kind: "pass" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @polyant/engine -- optout.guard`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/optout/optout.types.ts packages/engine/src/optout/optout.guard.ts packages/engine/src/optout/optout.guard.test.ts
git commit -F /tmp/commit-optout-3.txt
```
Commit body:
```
feat(optout): add pure evaluateOptout guard

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 3 — Contact opt-out store

### Task 4: `contact-optouts.store.ts`

**Files:**
- Create: `packages/engine/src/optout/contact-optouts.store.ts`
- Test: `packages/engine/src/optout/contact-optouts.store.test.ts`

- [ ] **Step 1: Write the failing test (cache behavior is the unit-testable part)**

Create `packages/engine/src/optout/contact-optouts.store.test.ts`. This test exercises the in-memory status cache without a DB by injecting a fake loader — so the store exposes a small testable seam:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { OptoutStatusCache } from "./contact-optouts.store.js";

describe("OptoutStatusCache", () => {
  it("loads on miss and serves subsequent reads from cache", async () => {
    const loader = vi.fn().mockResolvedValue("opted_out");
    const cache = new OptoutStatusCache(loader);
    expect(await cache.get("inst", "whatsapp", "+39111")).toBe("opted_out");
    expect(await cache.get("inst", "whatsapp", "+39111")).toBe("opted_out");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidates a single contact on write", async () => {
    const loader = vi.fn().mockResolvedValueOnce("opted_in").mockResolvedValueOnce("opted_out");
    const cache = new OptoutStatusCache(loader);
    expect(await cache.get("inst", "whatsapp", "+39111")).toBe("opted_in");
    cache.invalidate("inst", "whatsapp", "+39111");
    expect(await cache.get("inst", "whatsapp", "+39111")).toBe("opted_out");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keys are scoped per (instance, channel, id)", async () => {
    const loader = vi.fn(async (_i: string, _c: string, id: string) => (id === "a" ? "opted_out" : "opted_in"));
    const cache = new OptoutStatusCache(loader);
    expect(await cache.get("inst", "whatsapp", "a")).toBe("opted_out");
    expect(await cache.get("inst", "whatsapp", "b")).toBe("opted_in");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 1b: Run the test to verify it fails**

Run: `npm test -w @polyant/engine -- contact-optouts.store`
Expected: FAIL — `OptoutStatusCache` not exported.

- [ ] **Step 2: Implement the store**

Create `packages/engine/src/optout/contact-optouts.store.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../database/client.js";
import { contactOptouts } from "./optout.schema.js";
import { resolveInstanceId } from "../instances/resolve-instance-id.js";
import { asInstanceSlug, type InstanceSlug, type InstanceUuid } from "../instances/identifiers.js";
import { TtlCache } from "../utils/ttl-cache.js";
import type { OptoutStatus } from "./optout.types.js";

type StatusLoader = (
  instanceSlug: string,
  channelType: string,
  channelId: string,
) => Promise<OptoutStatus>;

/**
 * Hot-path status cache keyed by `${slug}:${channel}:${id}`. Checked on every
 * inbound message and every proactive outbound send. Short TTL + explicit
 * invalidation on write. The loader seam keeps it unit-testable without a DB.
 */
export class OptoutStatusCache {
  private readonly cache = new TtlCache<string, OptoutStatus>({ maxSize: 5000, ttlMs: 30_000 });
  constructor(private readonly loader: StatusLoader) {}

  private key(slug: string, channelType: string, channelId: string): string {
    return `${slug}:${channelType}:${channelId}`;
  }

  async get(slug: string, channelType: string, channelId: string): Promise<OptoutStatus> {
    const k = this.key(slug, channelType, channelId);
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    const status = await this.loader(slug, channelType, channelId);
    this.cache.set(k, status);
    return status;
  }

  invalidate(slug: string, channelType: string, channelId: string): void {
    this.cache.delete(this.key(slug, channelType, channelId));
  }
}

/** DB loader: a contact with no row is subscribed (opted_in). */
async function loadStatusFromDb(
  instanceSlug: string,
  channelType: string,
  channelId: string,
): Promise<OptoutStatus> {
  const instanceId = await resolveInstanceId(asInstanceSlug(instanceSlug));
  if (!instanceId) return "opted_in";
  const rows = await db
    .select({ status: contactOptouts.status })
    .from(contactOptouts)
    .where(
      and(
        eq(contactOptouts.instanceId, instanceId),
        eq(contactOptouts.channelType, channelType),
        eq(contactOptouts.channelId, channelId),
      ),
    )
    .limit(1);
  return (rows[0]?.status as OptoutStatus) ?? "opted_in";
}

const statusCache = new OptoutStatusCache(loadStatusFromDb);

/** Resolve the current opt-out status for a contact (cached). */
export async function getOptoutStatus(
  instanceSlug: InstanceSlug,
  channelType: string,
  channelId: string,
): Promise<OptoutStatus> {
  return statusCache.get(instanceSlug, channelType, channelId);
}

/** Upsert the status for a contact and invalidate the cache. */
export async function setOptoutStatus(args: {
  instanceId: InstanceUuid;
  instanceSlug: InstanceSlug;
  channelType: string;
  channelId: string;
  status: OptoutStatus;
  source: "user" | "admin";
}): Promise<void> {
  await db
    .insert(contactOptouts)
    .values({
      instanceId: args.instanceId,
      channelType: args.channelType,
      channelId: args.channelId,
      status: args.status,
      source: args.source,
    })
    .onConflictDoUpdate({
      target: [contactOptouts.instanceId, contactOptouts.channelType, contactOptouts.channelId],
      set: { status: args.status, source: args.source, updatedAt: sql`now()` },
    });
  statusCache.invalidate(args.instanceSlug, args.channelType, args.channelId);
}

export interface OptoutContactRow {
  channelType: string;
  channelId: string;
  status: OptoutStatus;
  source: string;
  updatedAt: Date | null;
}

/** Paginated list of opt-out rows for an instance (admin UI), default opted_out only. */
export async function listOptouts(
  instanceId: InstanceUuid,
  opts: { status?: OptoutStatus; limit?: number; offset?: number } = {},
): Promise<OptoutContactRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const where = opts.status
    ? and(eq(contactOptouts.instanceId, instanceId), eq(contactOptouts.status, opts.status))
    : eq(contactOptouts.instanceId, instanceId);
  const rows = await db
    .select({
      channelType: contactOptouts.channelType,
      channelId: contactOptouts.channelId,
      status: contactOptouts.status,
      source: contactOptouts.source,
      updatedAt: contactOptouts.updatedAt,
    })
    .from(contactOptouts)
    .where(where)
    .orderBy(desc(contactOptouts.updatedAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({ ...r, status: r.status as OptoutStatus }));
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm test -w @polyant/engine -- contact-optouts.store`
Expected: PASS (3 tests).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/optout/contact-optouts.store.ts packages/engine/src/optout/contact-optouts.store.test.ts
git commit -F /tmp/commit-optout-4.txt
```
Commit body:
```
feat(optout): add contact opt-out store with hot-path status cache

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 4 — Config resolver threading

### Task 5: Expose `optout` config on `InstanceConfig`

**Files:**
- Modify: `packages/engine/src/instances/config-resolver.ts:12-47` (interface), `:90-106` (fallback), `:134-167` (build)

- [ ] **Step 1: Add the `optout` field to `InstanceConfig`**

In `packages/engine/src/instances/config-resolver.ts`, add to the `InstanceConfig` interface after `debugEnabled` (line 42):

```ts
  /** GDPR opt-out feature config (per instance). */
  optout: {
    enabled: boolean;
    stopKeywords: string[];
    resumeKeywords: string[];
    closingMessage: string | null;
    resumeMessage: string | null;
    injectPromptHint: boolean;
  };
```

- [ ] **Step 2: Add it to the minimal fallback config**

In the `if (!instance)` block (around line 91-105), add before the closing `}`:

```ts
      optout: { enabled: false, stopKeywords: ["STOP"], resumeKeywords: ["START"], closingMessage: null, resumeMessage: null, injectPromptHint: true },
```

- [ ] **Step 3: Build it from the instance row**

In the `const config: InstanceConfig = {` object (around line 163-166), add after `debugEnabled: instance.debugEnabled,`:

```ts
    optout: {
      enabled: instance.optoutEnabled,
      stopKeywords: instance.optoutStopKeywords,
      resumeKeywords: instance.optoutResumeKeywords,
      closingMessage: instance.optoutClosingMessage,
      resumeMessage: instance.optoutResumeMessage,
      injectPromptHint: instance.optoutInjectPromptHint,
    },
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/instances/config-resolver.ts
git commit -F /tmp/commit-optout-5.txt
```
Commit body:
```
feat(optout): thread opt-out config through config-resolver

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 5 — Inbound gate + persistence

### Task 6: `optout-gate.ts` (runOptoutGate + exchange persistence)

**Files:**
- Create: `packages/engine/src/optout/optout-gate.ts`
- Create: `packages/engine/src/optout/index.ts`
- Test: `packages/engine/src/optout/optout-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/optout/optout-gate.test.ts`. We test the decision branches by mocking the store + config resolver + conversation store (the gate's only collaborators):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const getOptoutStatus = vi.fn();
const setOptoutStatus = vi.fn();
const resolveInstanceConfig = vi.fn();
const resolveInstanceId = vi.fn();
const ensureConversation = vi.fn();
const appendMessages = vi.fn();
const auditLog = vi.fn();

vi.mock("./contact-optouts.store.js", () => ({ getOptoutStatus, setOptoutStatus }));
vi.mock("../instances/config-resolver.js", () => ({ resolveInstanceConfig }));
vi.mock("../instances/resolve-instance-id.js", () => ({ resolveInstanceId }));
vi.mock("../conversations/index.js", () => ({ conversationStore: { ensureConversation, appendMessages } }));
vi.mock("../audit/audit-logger.js", () => ({ createAuditLogger: () => ({ log: auditLog }) }));

import { runOptoutGate } from "./optout-gate.js";
import type { IncomingMessage } from "../channels/types.js";

const baseMsg = (text: string): IncomingMessage => ({
  channelType: "whatsapp",
  channelId: "+39111",
  instanceId: "acme" as never,
  userName: "Mario",
  text,
  metadata: {},
});

const enabledConfig = {
  optout: { enabled: true, stopKeywords: ["STOP"], resumeKeywords: ["START"], closingMessage: "Bye.", resumeMessage: "Hi again.", injectPromptHint: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveInstanceConfig.mockResolvedValue(enabledConfig);
  resolveInstanceId.mockResolvedValue("uuid-1");
  ensureConversation.mockResolvedValue({ created: true });
  appendMessages.mockResolvedValue(undefined);
});

describe("runOptoutGate", () => {
  it("proceeds for synthetic channels without touching the store", async () => {
    const res = await runOptoutGate({ ...baseMsg("STOP"), channelType: "room" as never });
    expect(res).toEqual({ proceed: true });
    expect(resolveInstanceConfig).not.toHaveBeenCalled();
  });

  it("proceeds for auto-task messages", async () => {
    const res = await runOptoutGate(baseMsg("### Task:\nGenerate a title"));
    expect(res).toEqual({ proceed: true });
  });

  it("proceeds when the feature is disabled", async () => {
    resolveInstanceConfig.mockResolvedValue({ optout: { ...enabledConfig.optout, enabled: false } });
    const res = await runOptoutGate(baseMsg("STOP"));
    expect(res).toEqual({ proceed: true });
  });

  it("records opt-out and returns the closing message on STOP", async () => {
    getOptoutStatus.mockResolvedValue("opted_in");
    const res = await runOptoutGate(baseMsg("STOP"));
    expect(setOptoutStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "opted_out", source: "user", channelId: "+39111" }));
    expect(res).toEqual({ proceed: false, reply: "Bye." });
    expect(appendMessages).toHaveBeenCalled(); // exchange persisted
  });

  it("returns silence (empty reply) for a normal message while opted out", async () => {
    getOptoutStatus.mockResolvedValue("opted_out");
    const res = await runOptoutGate(baseMsg("are you there?"));
    expect(res).toEqual({ proceed: false, reply: "" });
    expect(setOptoutStatus).not.toHaveBeenCalled();
    expect(appendMessages).not.toHaveBeenCalled(); // silenced messages are not persisted
  });

  it("clears opt-out and returns the resume message on START", async () => {
    getOptoutStatus.mockResolvedValue("opted_out");
    const res = await runOptoutGate(baseMsg("START"));
    expect(setOptoutStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "opted_in", source: "user" }));
    expect(res).toEqual({ proceed: false, reply: "Hi again." });
  });
});
```

- [ ] **Step 1b: Run the test to verify it fails**

Run: `npm test -w @polyant/engine -- optout-gate`
Expected: FAIL — `runOptoutGate` not exported.

- [ ] **Step 2: Implement the gate**

Create `packages/engine/src/optout/optout-gate.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IncomingMessage } from "../channels/types.js";
import { isAutoTask } from "../pipeline.js";
import { resolveInstanceConfig } from "../instances/config-resolver.js";
import { resolveInstanceId } from "../instances/resolve-instance-id.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { conversationStore } from "../conversations/index.js";
import { createAuditLogger } from "../audit/audit-logger.js";
import { evaluateOptout } from "./optout.guard.js";
import { getOptoutStatus, setOptoutStatus } from "./contact-optouts.store.js";

/** Synthetic channels never participate in opt-out (no real end-user contact). */
const OPTOUT_EXCLUDED_CHANNELS = new Set(["agent", "scheduled", "room"]);

export type OptoutGateResult = { proceed: true } | { proceed: false; reply: string };

/**
 * Deterministic pre-LLM opt-out gate. Runs at the very top of the message
 * handler, before Room/task routing and context prep, so STOP/START are always
 * honored first. Returns `{ proceed: true }` for the normal path, or a
 * short-circuit reply (possibly empty = no outbound) when the message is a
 * STOP/START transition or the contact is silenced.
 */
export async function runOptoutGate(msg: IncomingMessage): Promise<OptoutGateResult> {
  if (OPTOUT_EXCLUDED_CHANNELS.has(msg.channelType) || isAutoTask(msg.text)) {
    return { proceed: true };
  }

  const instanceSlug = msg.instanceId;
  const config = await resolveInstanceConfig(instanceSlug);
  if (!config.optout.enabled) return { proceed: true };

  const status = await getOptoutStatus(instanceSlug, msg.channelType, msg.channelId);
  const action = evaluateOptout({ config: config.optout, currentStatus: status, messageText: msg.text });

  if (action.kind === "pass") return { proceed: true };
  if (action.kind === "blocked_silent") return { proceed: false, reply: "" };

  // stop | resume — persist the transition, audit, and the conversation exchange.
  const newStatus = action.kind === "stop" ? "opted_out" : "opted_in";
  const instanceUuid = await resolveInstanceId(asInstanceSlug(instanceSlug));
  const audit = createAuditLogger(`optout:${action.kind}`, instanceSlug, undefined);
  const started = Date.now();
  try {
    if (instanceUuid) {
      await setOptoutStatus({
        instanceId: instanceUuid,
        instanceSlug,
        channelType: msg.channelType,
        channelId: msg.channelId,
        status: newStatus,
        source: "user",
      });
    }
    audit.log({
      action: `optout:${action.kind}`,
      success: true,
      durationMs: Date.now() - started,
      details: { channelType: msg.channelType, channelId: msg.channelId },
    });
  } catch (err) {
    audit.log({
      action: `optout:${action.kind}`,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      details: { channelType: msg.channelType, channelId: msg.channelId },
    });
  }

  await persistOptoutExchange(msg, action.reply ?? "");
  return { proceed: false, reply: action.reply ?? "" };
}

/**
 * Persist the STOP/START exchange (user keyword + confirmation) to the
 * conversation for admin visibility — lightweight: no memory/summary/trace/hooks.
 * Best-effort: a persistence failure never blocks honoring the opt-out.
 */
async function persistOptoutExchange(msg: IncomingMessage, reply: string): Promise<void> {
  const conversationId = `${msg.instanceId}:${msg.channelType}:${msg.channelId}`;
  try {
    await conversationStore.ensureConversation(conversationId, msg.instanceId, {
      channel: msg.channelType,
      userIdentifier: msg.userName,
      source: "user",
    });
    const messages = [{ role: "user", content: msg.text }];
    if (reply) messages.push({ role: "assistant", content: reply });
    await conversationStore.appendMessages(conversationId, messages);
  } catch (err) {
    console.error(`[optout] failed to persist exchange for ${conversationId}:`, err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 3: Create the barrel**

Create `packages/engine/src/optout/index.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

export { runOptoutGate, type OptoutGateResult } from "./optout-gate.js";
export { getOptoutStatus, setOptoutStatus, listOptouts, type OptoutContactRow } from "./contact-optouts.store.js";
export { evaluateOptout } from "./optout.guard.js";
export type { OptoutConfig, OptoutStatus, OptoutAction } from "./optout.types.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @polyant/engine -- optout-gate`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/optout/optout-gate.ts packages/engine/src/optout/optout-gate.test.ts packages/engine/src/optout/index.ts
git commit -F /tmp/commit-optout-6.txt
```
Commit body:
```
feat(optout): add inbound opt-out gate with exchange persistence

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 7: Wire the gate into the message handlers

**Files:**
- Modify: `packages/engine/src/index.ts:158` (`handleMessage`), `:253` (`handleMessageStream`)

- [ ] **Step 1: Import the gate**

In `packages/engine/src/index.ts`, add to the imports near the top (after the pipeline import block, line 38):

```ts
import { runOptoutGate } from "./optout/index.js";
```

- [ ] **Step 2: Gate `handleMessage` (sync path)**

In `handleMessage` (line 158), insert at the very start of the function body, before the `activeTrigger` line (159-163):

```ts
    // GDPR opt-out gate (deterministic, pre-LLM, before Room/task routing so
    // STOP/START are always honored first). Returns a short-circuit reply
    // (possibly empty = no outbound) or proceeds to the normal pipeline.
    const optoutGate = await runOptoutGate(msg);
    if (!optoutGate.proceed) {
      return { text: optoutGate.reply };
    }
```

- [ ] **Step 3: Gate `handleMessageStream` (streaming path)**

In `handleMessageStream` (line 253), insert at the very start of the function body, before `// Phase 1` (line 254):

```ts
    // GDPR opt-out gate — same deterministic short-circuit as the sync path,
    // wrapped as a single-chunk stream (reusing the missing-key pattern below).
    const optoutGate = await runOptoutGate(msg);
    if (!optoutGate.proceed) {
      const reply = optoutGate.reply;
      async function* singleChunk() { if (reply) yield reply; }
      return {
        textStream: singleChunk(),
        fullStream: (async function* () { if (reply) yield { type: "text-delta", text: reply }; })(),
        completed: Promise.resolve({ text: reply }),
      };
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/index.ts
git commit -F /tmp/commit-optout-7.txt
```
Commit body:
```
feat(optout): wire inbound opt-out gate into message handlers

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 6 — Outbound suppression

### Task 8: Suppress proactive sends to opted-out contacts

**Files:**
- Modify: `packages/engine/src/channels/channel-manager.ts:73-74` (coordinator wiring), `:189-233` (sendOutbound), `:239-257` (sendOutboundTemplate)

- [ ] **Step 1: Import the status lookup**

In `packages/engine/src/channels/channel-manager.ts`, add to the imports:

```ts
import { getOptoutStatus } from "../optout/index.js";
```

- [ ] **Step 2: Add a private suppression check**

Add this private method to the `ChannelManager` class (e.g. just before `sendOutbound`, line 188):

```ts
  /**
   * True when a proactive send to this contact must be suppressed (GDPR opt-out).
   * Reactive replies pass `skipOptoutCheck` because the inbound gate already
   * enforced silence; only closing/resume confirmations reach an opted-out
   * contact, and those must go through. Best-effort: a lookup error never blocks
   * a legitimate send.
   */
  private async isOptoutSuppressed(instanceSlug: string, channelType: string, channelId: string): Promise<boolean> {
    try {
      const status = await getOptoutStatus(asInstanceSlug(instanceSlug), channelType, channelId);
      return status === "opted_out";
    } catch (err) {
      console.error("[channel-manager] opt-out check failed (allowing send):", err);
      return false;
    }
  }
```

- [ ] **Step 3: Gate `sendOutbound`**

Change the `sendOutbound` signature (line 189-195) to accept `skipOptoutCheck`:

```ts
  async sendOutbound(
    instanceSlug: string,
    channelType: string,
    channelId: string,
    message: string,
    opts?: { mediaUrl?: string | string[]; skipOptoutCheck?: boolean },
  ): Promise<void> {
```

Then, immediately after resolving `instanceMap`/`adapter` (after line 200, before `let ok = false;`), add:

```ts
    if (!opts?.skipOptoutCheck && (await this.isOptoutSuppressed(instanceSlug, channelType, channelId))) {
      console.log(`[channel-manager] outbound suppressed (opt-out): ${instanceSlug} ${channelType}:${channelId}`);
      return;
    }
```

- [ ] **Step 4: Gate `sendOutboundTemplate`**

In `sendOutboundTemplate` (line 239), after resolving `adapter` and before the `if (!adapter.sendTemplate)` check (line 252), add:

```ts
    if (await this.isOptoutSuppressed(instanceSlug, channelType, channelId)) {
      console.log(`[channel-manager] template suppressed (opt-out): ${instanceSlug} ${channelType}:${channelId}`);
      throw new Error(`Outbound suppressed: contact ${channelType}:${channelId} has opted out`);
    }
```

(Templates are proactive WhatsApp sends; throwing surfaces the suppression to the calling tool rather than silently dropping a template send.)

- [ ] **Step 5: Make the reactive coordinator skip the check**

In the coordinator wiring (line 73-74), change:

```ts
        sendOutbound: (slug, channelType, channelId, text) =>
          this.sendOutbound(slug, channelType, channelId, text, { skipOptoutCheck: true }),
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/channels/channel-manager.ts
git commit -F /tmp/commit-optout-8.txt
```
Commit body:
```
feat(optout): suppress proactive outbound sends to opted-out contacts

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 7 — Informational prompt injection

### Task 9: Render an opt-out hint into the supervisor prompt

**Files:**
- Modify: `packages/engine/src/agents/supervisor/prompt.ts:23-48` (PromptOptions), `:78-81` (renderer), `:290-293` (assembly)
- Modify: `packages/engine/src/agents/supervisor/index.ts:31-101` (SupervisorInput), `:397-406` (prompt call)
- Modify: `packages/engine/src/index.ts:195-218` + `:263-286` (supervise/superviseStream calls)

- [ ] **Step 1: Add the prompt option + renderer**

In `packages/engine/src/agents/supervisor/prompt.ts`, add to `PromptOptions` (after `conversationState`, line 47):

```ts
  /**
   * When set, render an informational opt-out section so the agent can tell users
   * how to stop/resume messages. The agent NEVER enforces this — handled by the
   * deterministic gate. Undefined = not injected.
   */
  optoutHint?: { stopKeywords: string[]; resumeKeywords: string[] };
```

Add a renderer next to `renderConversationStateSection` (after line 81):

```ts
/**
 * Informational only: tells the agent the user may stop/resume messages with the
 * configured keywords, so it can communicate this when appropriate. Enforcement
 * is deterministic (opt-out gate) — the agent must not act on it itself.
 */
function renderOptoutHintSection(hint: NonNullable<PromptOptions["optoutHint"]>): string {
  const stop = hint.stopKeywords.join(", ");
  const resume = hint.resumeKeywords.join(", ");
  return [
    `## Messaging opt-out`,
    ``,
    `The user can stop receiving all messages by sending: ${stop}.` +
      (resume ? ` They can resume later by sending: ${resume}.` : ``),
    `If asked how to unsubscribe, share this. Do NOT try to process opt-out yourself — the system handles it automatically.`,
  ].join("\n");
}
```

Add to the assembly, right after the `conversationState` block (after line 293):

```ts
  if (options.optoutHint) {
    sections.push(renderOptoutHintSection(options.optoutHint));
  }
```

- [ ] **Step 2: Thread the option through the supervisor input**

In `packages/engine/src/agents/supervisor/index.ts`, add to `SupervisorInput` (after `stateInPromptEnabled`, line 58):

```ts
  /** Informational opt-out hint to render into the prompt (set when the instance enables it). */
  optoutHint?: { stopKeywords: string[]; resumeKeywords: string[] };
```

Then pass it in the `buildSupervisorSystemPrompt` call in `prepareSupervisor` (after `conversationState`, line 405):

```ts
    optoutHint: input.optoutHint,
```

- [ ] **Step 3: Populate the hint from instance config in both handlers**

In `packages/engine/src/index.ts`, in BOTH the `supervise(...)` call (after `debugEnabled:`, line 217) and the `superviseStream(...)` call (after `debugEnabled:`, line 285), add:

```ts
        optoutHint:
          ctx.instanceConfig.optout.enabled && ctx.instanceConfig.optout.injectPromptHint
            ? { stopKeywords: ctx.instanceConfig.optout.stopKeywords, resumeKeywords: ctx.instanceConfig.optout.resumeKeywords }
            : undefined,
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agents/supervisor/prompt.ts packages/engine/src/agents/supervisor/index.ts packages/engine/src/index.ts
git commit -F /tmp/commit-optout-9.txt
```
Commit body:
```
feat(optout): inject informational opt-out hint into supervisor prompt

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 8 — Admin API

### Task 10: Expose opt-out config on the instance endpoints

**Files:**
- Modify: `packages/engine/src/server/instances/instances.controller.ts:44-69` (toInstanceDto), `:166-193` (PATCH)

- [ ] **Step 1: Add the fields to the response DTO**

In `toInstanceDto` (line 44-69), add after `debugEnabled: instance.debugEnabled,` (line 61):

```ts
    optoutEnabled: instance.optoutEnabled,
    optoutStopKeywords: instance.optoutStopKeywords,
    optoutResumeKeywords: instance.optoutResumeKeywords,
    optoutClosingMessage: instance.optoutClosingMessage,
    optoutResumeMessage: instance.optoutResumeMessage,
    optoutInjectPromptHint: instance.optoutInjectPromptHint,
```

- [ ] **Step 2: Accept the fields in PATCH + validate keyword arrays**

In the `update` method, extend the `@Body()` type (after `debugEnabled?: boolean;`, line 183):

```ts
      optoutEnabled?: boolean;
      optoutStopKeywords?: string[];
      optoutResumeKeywords?: string[];
      optoutClosingMessage?: string | null;
      optoutResumeMessage?: string | null;
      optoutInjectPromptHint?: boolean;
```

Then add validation + normalization at the start of the method body, after `this.validateModelConfig(...)` (line 188):

```ts
    body.optoutStopKeywords = this.normalizeKeywords(body.optoutStopKeywords, "optoutStopKeywords");
    body.optoutResumeKeywords = this.normalizeKeywords(body.optoutResumeKeywords, "optoutResumeKeywords");
```

Add this private helper to the controller class (e.g. after `validateModelConfig`):

```ts
  /** Validate + normalize a keyword list: non-empty trimmed strings, deduped (case-insensitive). */
  private normalizeKeywords(keywords: string[] | undefined, field: string): string[] | undefined {
    if (keywords === undefined) return undefined;
    if (!Array.isArray(keywords)) throw new BadRequestException(`${field} must be an array of strings`);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of keywords) {
      if (typeof raw !== "string") throw new BadRequestException(`${field} must contain only strings`);
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(trimmed);
    }
    if (out.length === 0) throw new BadRequestException(`${field} must contain at least one non-empty keyword`);
    return out;
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/server/instances/instances.controller.ts
git commit -F /tmp/commit-optout-10.txt
```
Commit body:
```
feat(optout): expose opt-out config on instance API

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 11: Opt-out contacts controller (list + manual override)

**Files:**
- Create: `packages/engine/src/server/optouts/optouts.controller.ts`
- Create: `packages/engine/src/server/optouts/optouts.module.ts`
- Modify: the root server module that aggregates controllers (find it: `grep -rln "InstancesController" packages/engine/src/server/*.module.ts packages/engine/src/server/**/*.module.ts`) — register `OptoutsModule`.

- [ ] **Step 1: Write the controller**

Create `packages/engine/src/server/optouts/optouts.controller.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { findInstanceBySlug } from "../../instances/store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { listOptouts, setOptoutStatus, type OptoutStatus } from "../../optout/index.js";

/**
 * Admin management of opt-out contacts. All operations are instance-scoped:
 * the slug is resolved to a uuid and every query is constrained by it (IDOR-safe).
 */
@Controller("api/instances/:slug/optouts")
export class OptoutsController {
  // GET — paginated list (default: currently opted-out contacts)
  @Get()
  async list(
    @Param("slug") slug: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
  ) {
    const instance = await this.resolve(slug);
    const limit = 50;
    const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
    const effectiveStatus: OptoutStatus | undefined =
      status === "opted_in" ? "opted_in" : status === "all" ? undefined : "opted_out";
    const optouts = await listOptouts(instance.id, {
      status: effectiveStatus,
      limit,
      offset: (pageNum - 1) * limit,
    });
    return { optouts, page: pageNum };
  }

  // POST — manually opt a contact OUT (admin override)
  @Post()
  async optOut(
    @Param("slug") slug: string,
    @Body() body: { channelType?: string; channelId?: string },
  ) {
    const instance = await this.resolve(slug);
    const { channelType, channelId } = this.validateContact(body);
    await setOptoutStatus({
      instanceId: instance.id,
      instanceSlug: instance.slug,
      channelType,
      channelId,
      status: "opted_out",
      source: "admin",
    });
    return { ok: true };
  }

  // DELETE — manually opt a contact back IN (admin override)
  @Delete(":channelType/:channelId")
  async optIn(
    @Param("slug") slug: string,
    @Param("channelType") channelType: string,
    @Param("channelId") channelId: string,
  ) {
    const instance = await this.resolve(slug);
    await setOptoutStatus({
      instanceId: instance.id,
      instanceSlug: instance.slug,
      channelType,
      channelId: decodeURIComponent(channelId),
      status: "opted_in",
      source: "admin",
    });
    return { ok: true };
  }

  private async resolve(slug: string) {
    const instance = await findInstanceBySlug(asInstanceSlug(slug));
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    return instance;
  }

  private validateContact(body: { channelType?: string; channelId?: string }): {
    channelType: string;
    channelId: string;
  } {
    const channelType = body.channelType?.trim();
    const channelId = body.channelId?.trim();
    if (!channelType || !channelId) {
      throw new BadRequestException("channelType and channelId are required");
    }
    return { channelType, channelId };
  }
}
```

- [ ] **Step 2: Write the module**

Create `packages/engine/src/server/optouts/optouts.module.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module } from "@nestjs/common";
import { OptoutsController } from "./optouts.controller.js";

@Module({
  controllers: [OptoutsController],
})
export class OptoutsModule {}
```

- [ ] **Step 3: Register the module**

Find the module that imports `InstancesController`/`InstancesModule` (run the grep above). In that module's `imports` (or `controllers`) array, add `OptoutsModule`:

```ts
import { OptoutsModule } from "./optouts/optouts.module.js";
// ...
  imports: [ /* ...existing... */ OptoutsModule ],
```

(If the server registers controllers directly rather than feature modules, add `OptoutsController` to the `controllers` array instead — match the existing pattern.)

- [ ] **Step 4: Typecheck + lint (verifies @Inject rule — this controller has no constructor, so it's fine)**

Run: `npm run typecheck -w @polyant/engine && npm run lint -w @polyant/engine`
Expected: PASS.

- [ ] **Step 5: Smoke test the routes (engine running + an instance with opt-out enabled)**

Run (replace `<slug>` and auth as needed):
```bash
curl -s "http://localhost:3001/api/instances/<slug>/optouts" | head
curl -s -X POST "http://localhost:3001/api/instances/<slug>/optouts" -H 'content-type: application/json' -d '{"channelType":"whatsapp","channelId":"+39000"}'
curl -s "http://localhost:3001/api/instances/<slug>/optouts" | head
curl -s -X DELETE "http://localhost:3001/api/instances/<slug>/optouts/whatsapp/%2B39000"
```
Expected: list returns `{ optouts: [...] }`; POST then list shows the contact `opted_out`; DELETE flips it.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/server/optouts/ packages/engine/src/server/*.module.ts
git commit -F /tmp/commit-optout-11.txt
```
Commit body:
```
feat(optout): add admin endpoints to list and override opt-out contacts

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 9 — Admin web (Privacy tab)

> Follow the existing tab pattern. Use `hooks-tab.tsx` and `room-tab.tsx` as templates for data fetching, the `settings-tab.tsx` for the config-form-with-save pattern, and `room-backlog-section.tsx` for a paginated table. Use design tokens / shadcn components per the frontend-design-system skill — no hardcoded colors.

### Task 12: API client types + methods

**Files:**
- Modify: `packages/web/src/lib/api-types.ts`
- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Add types**

In `packages/web/src/lib/api-types.ts`, add:

```ts
export interface OptoutContact {
  channelType: string;
  channelId: string;
  status: "opted_out" | "opted_in";
  source: string;
  updatedAt: string | null;
}
```

Then extend the existing `Instance` type (find it in this file) with the opt-out config fields:

```ts
  optoutEnabled: boolean;
  optoutStopKeywords: string[];
  optoutResumeKeywords: string[];
  optoutClosingMessage: string | null;
  optoutResumeMessage: string | null;
  optoutInjectPromptHint: boolean;
```

- [ ] **Step 2: Add client methods**

In `packages/web/src/lib/api.ts`, add an `optouts` group (mirror the existing grouped API objects, e.g. near `skills`/`tools`). Import `OptoutContact` in the type import block at the top:

```ts
  optouts: {
    list: (slug: string, params?: { status?: string; page?: number }) => {
      const q = new URLSearchParams();
      if (params?.status) q.set("status", params.status);
      if (params?.page) q.set("page", String(params.page));
      const qs = q.toString();
      return request<{ optouts: OptoutContact[]; page: number }>(
        `/api/instances/${encodeURIComponent(slug)}/optouts${qs ? `?${qs}` : ""}`,
      );
    },
    optOut: (slug: string, channelType: string, channelId: string) =>
      request<{ ok: boolean }>(`/api/instances/${encodeURIComponent(slug)}/optouts`, {
        method: "POST",
        body: JSON.stringify({ channelType, channelId }),
      }),
    optIn: (slug: string, channelType: string, channelId: string) =>
      request<{ ok: boolean }>(
        `/api/instances/${encodeURIComponent(slug)}/optouts/${encodeURIComponent(channelType)}/${encodeURIComponent(channelId)}`,
        { method: "DELETE" },
      ),
  },
```

(The instance config is saved through the existing `instances.update(slug, body)` method — it already PATCHes `/api/instances/:slug`; no new method needed.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w @polyant/web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/api.ts packages/web/src/lib/api-types.ts
git commit -F /tmp/commit-optout-12.txt
```
Commit body:
```
feat(web): add opt-out API client methods and types

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

### Task 13: Privacy tab (config form + contacts list)

**Files:**
- Create: `packages/web/src/app/(admin)/instances/[slug]/privacy-tab.tsx`
- Modify: `packages/web/src/app/(admin)/instances/[slug]/page.tsx` (register the tab)
- Modify: `packages/web/src/lib/i18n/*` (Italian + English strings)

- [ ] **Step 1: Build the tab component**

Create `packages/web/src/app/(admin)/instances/[slug]/privacy-tab.tsx`. Use the structure below; match the imports/components used by `settings-tab.tsx` (Card, Switch, Input, Textarea, Button, toast) and `room-backlog-section.tsx` (Table). Keyword lists are edited as comma-separated text for v1 simplicity, split/trimmed on save.

```tsx
"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Instance, OptoutContact } from "@/lib/api-types";
// import Card/Switch/Input/Textarea/Button/Table/Label from "@/components/ui/*"
// import { useT } from "@/lib/i18n" (match how other tabs read translations)

export function PrivacyTab({ instance, onSaved }: { instance: Instance; onSaved?: () => void }) {
  const [enabled, setEnabled] = useState(instance.optoutEnabled);
  const [stop, setStop] = useState(instance.optoutStopKeywords.join(", "));
  const [resume, setResume] = useState(instance.optoutResumeKeywords.join(", "));
  const [closing, setClosing] = useState(instance.optoutClosingMessage ?? "");
  const [resumeMsg, setResumeMsg] = useState(instance.optoutResumeMessage ?? "");
  const [injectHint, setInjectHint] = useState(instance.optoutInjectPromptHint);
  const [saving, setSaving] = useState(false);

  const [contacts, setContacts] = useState<OptoutContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);

  const parse = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  async function refreshContacts() {
    setLoadingContacts(true);
    try {
      const res = await api.optouts.list(instance.slug, { status: "opted_out" });
      setContacts(res.optouts);
    } finally {
      setLoadingContacts(false);
    }
  }

  useEffect(() => { void refreshContacts(); /* eslint-disable-next-line */ }, [instance.slug]);

  async function save() {
    setSaving(true);
    try {
      await api.instances.update(instance.slug, {
        optoutEnabled: enabled,
        optoutStopKeywords: parse(stop),
        optoutResumeKeywords: parse(resume),
        optoutClosingMessage: closing || null,
        optoutResumeMessage: resumeMsg || null,
        optoutInjectPromptHint: injectHint,
      });
      onSaved?.();
    } finally {
      setSaving(false);
    }
  }

  async function reEnable(c: OptoutContact) {
    await api.optouts.optIn(instance.slug, c.channelType, c.channelId);
    await refreshContacts();
  }

  // Render:
  //  - A "GDPR opt-out" config Card: Switch(enabled), Input(stop), Input(resume),
  //    Textarea(closing), Textarea(resumeMsg), Switch(injectHint), Save button.
  //  - A "Opted-out contacts" Card: a Table (channel, id, date, source) with a
  //    "Re-enable" button per row; an "Opt out a contact" form (channelType + channelId).
  //  - Use the design system tokens; no hardcoded colors. Strings via i18n keys (Step 3).
  return null; // replace with the JSX described above
}
```

> Implementation note: flesh out the JSX following `settings-tab.tsx` for the form and `room-backlog-section.tsx` for the table. Keep the file ≤ 400 lines; if it grows, split the contacts table into a `privacy-contacts-section.tsx` sibling.

- [ ] **Step 2: Register the tab in the instance page**

In `packages/web/src/app/(admin)/instances/[slug]/page.tsx`, add a `TabsTrigger` + `TabsContent` for "privacy" mirroring how `hooks-tab.tsx`/`room-tab.tsx` are wired (import `PrivacyTab`, add the trigger label via i18n, render `<PrivacyTab instance={instance} onSaved={reload} />` inside the matching `TabsContent`). Place it after the "Hooks" tab.

- [ ] **Step 3: Add i18n strings**

In the i18n dictionaries under `packages/web/src/lib/i18n/` (match the existing file structure — e.g. `it.ts`/`en.ts` or a nested object), add keys used by the tab, for example:

```ts
// English
privacy: {
  tab: "Privacy",
  title: "GDPR opt-out",
  enable: "Enable opt-out",
  stopKeywords: "Stop keywords (comma-separated)",
  resumeKeywords: "Resume keywords (comma-separated)",
  closingMessage: "Closing message (sent on opt-out)",
  resumeMessage: "Resume message (sent on resume)",
  injectHint: "Mention opt-out in the assistant prompt",
  save: "Save",
  contactsTitle: "Opted-out contacts",
  channel: "Channel", contact: "Contact", date: "Date", source: "Source",
  reEnable: "Re-enable", optOutContact: "Opt out a contact",
  empty: "No opted-out contacts.",
},
```

```ts
// Italian
privacy: {
  tab: "Privacy",
  title: "Opt-out GDPR",
  enable: "Abilita opt-out",
  stopKeywords: "Parole di stop (separate da virgola)",
  resumeKeywords: "Parole di riattivazione (separate da virgola)",
  closingMessage: "Messaggio di chiusura (inviato all'opt-out)",
  resumeMessage: "Messaggio di riattivazione",
  injectHint: "Indica l'opt-out nel prompt dell'assistente",
  save: "Salva",
  contactsTitle: "Contatti disiscritti",
  channel: "Canale", contact: "Contatto", date: "Data", source: "Origine",
  reEnable: "Riattiva", optOutContact: "Disiscrivi un contatto",
  empty: "Nessun contatto disiscritto.",
},
```

- [ ] **Step 4: Typecheck + lint + build**

Run: `npm run typecheck -w @polyant/web && npm run lint -w @polyant/web`
Expected: PASS.

- [ ] **Step 5: Manual check**

Run: `npm run dev:web` (engine also running). Open an instance → Privacy tab. Toggle enable, set keywords, save → reload shows persisted values. With opt-out enabled, send "STOP" to the instance via the playground → no normal reply; the closing message appears; the contact shows up in the table; "Re-enable" removes it.

- [ ] **Step 6: Commit**

```bash
git add "packages/web/src/app/(admin)/instances/[slug]/privacy-tab.tsx" "packages/web/src/app/(admin)/instances/[slug]/page.tsx" packages/web/src/lib/i18n/
git commit -F /tmp/commit-optout-13.txt
```
Commit body:
```
feat(web): add Privacy tab for opt-out config and contacts

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Phase 10 — Integration tests & final verification

### Task 14: Integration test for the end-to-end opt-out lifecycle

**Files:**
- Create: `packages/engine/src/optout/optout.integration.test.ts`

> These tests hit the real DB (run with `npm run test:integration -w @polyant/engine`, postgres up). They verify the store + cascade contract. Use an instance fixture; follow the setup pattern in an existing integration test (e.g. `scheduled-tasks/store.test.ts`).

- [ ] **Step 1: Write the integration test**

Create `packages/engine/src/optout/optout.integration.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../database/client.js";
import { instances } from "../instances/schema.js";
import { contactOptouts } from "./optout.schema.js";
import { eq } from "drizzle-orm";
import { asInstanceSlug, asInstanceUuid } from "../instances/identifiers.js";
import { getOptoutStatus, setOptoutStatus, listOptouts } from "./index.js";

const SLUG = asInstanceSlug("optout-itest");
let instanceId: ReturnType<typeof asInstanceUuid>;

beforeAll(async () => {
  const [row] = await db.insert(instances).values({ slug: SLUG, name: "Optout ITest" }).returning();
  instanceId = asInstanceUuid(row.id);
});

afterAll(async () => {
  await db.delete(instances).where(eq(instances.slug, SLUG)); // cascade drops contact_optouts
});

describe("contact opt-out lifecycle (integration)", () => {
  it("defaults to opted_in when no row exists", async () => {
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_in");
  });

  it("persists opt-out and reflects it (after cache TTL/invalidate) and re-opt-in", async () => {
    await setOptoutStatus({ instanceId, instanceSlug: SLUG, channelType: "whatsapp", channelId: "+39999", status: "opted_out", source: "user" });
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_out");
    const list = await listOptouts(instanceId, { status: "opted_out" });
    expect(list.some((r) => r.channelId === "+39999")).toBe(true);

    await setOptoutStatus({ instanceId, instanceSlug: SLUG, channelType: "whatsapp", channelId: "+39999", status: "opted_in", source: "admin" });
    expect(await getOptoutStatus(SLUG, "whatsapp", "+39999")).toBe("opted_in");
  });

  it("cascade: deleting the instance removes its opt-out rows", async () => {
    await setOptoutStatus({ instanceId, instanceSlug: SLUG, channelType: "telegram", channelId: "123", status: "opted_out", source: "user" });
    await db.delete(instances).where(eq(instances.slug, SLUG));
    const remaining = await db.select().from(contactOptouts).where(eq(contactOptouts.instanceId, instanceId));
    expect(remaining).toHaveLength(0);
    // Re-create for afterAll idempotency
    const [row] = await db.insert(instances).values({ slug: SLUG, name: "Optout ITest" }).returning();
    instanceId = asInstanceUuid(row.id);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npm run test:integration -w @polyant/engine -- optout`
Expected: PASS (3 tests). (Requires postgres up + migration 0049 applied.)

- [ ] **Step 3: Full verification sweep**

Run:
```bash
npm run typecheck
npm run lint
npm run test:unit -w @polyant/engine -- optout
```
Expected: all PASS. Fix any failure before continuing (classify per `.claude/rules/testing.md`).

- [ ] **Step 4: Update CLAUDE.md**

Add a bullet to the "Key Conventions" section of `CLAUDE.md` documenting the opt-out feature: deterministic inbound gate + outbound suppression chokepoints (`sendOutbound`/`sendOutboundTemplate`, coordinator skips via `skipOptoutCheck`), per-contact `contact_optouts` table (cascade on instance delete, NOT on conversation delete), config columns on `instances`, informational prompt hint, admin endpoints `GET/POST/DELETE /api/instances/:slug/optouts`, and the v1 limitation (STOP as a reply to a Room broadcast is not honored). Reference the spec path.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/optout/optout.integration.test.ts CLAUDE.md
git commit -F /tmp/commit-optout-14.txt
```
Commit body:
```
test(optout): add lifecycle integration test + document feature

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Self-Review (completed against the spec)

**Spec coverage:** §3 data model → Tasks 1-2; §4 guard → Task 3; §5 inbound enforcement → Tasks 6-7; §6 outbound suppression → Task 8; §7 exchange persistence → Task 6 (`persistOptoutExchange`); §8 prompt injection → Task 9; §9 stores/resolver → Tasks 4-5; §10 admin API + web → Tasks 10-13; §11 cascade/edge cases → Task 2 (FK cascade, no deleteConversation touch) + Task 14 (cascade test); §12 testing → Tasks 3,4,6,14.

**Placeholder scan:** Task 13's tab JSX is intentionally a structural skeleton (web UI is the one flexible, visual surface) with explicit component/section guidance and i18n keys — every other task contains complete code.

**Type consistency:** `OptoutConfig`/`OptoutStatus`/`OptoutAction` defined in Task 3 and reused verbatim in Tasks 4-6. `getOptoutStatus(slug, channelType, channelId)`, `setOptoutStatus({...})`, `listOptouts(uuid, {...})` signatures match across store (Task 4), gate (Task 6), channel-manager (Task 8), and controller (Task 11). `runOptoutGate(msg) → { proceed }` matches its wiring (Task 7). `sendOutbound(..., { skipOptoutCheck })` matches the coordinator change (Task 8).
