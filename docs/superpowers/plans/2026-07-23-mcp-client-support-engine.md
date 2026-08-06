# MCP Client Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Polyant instance connect to external remote MCP servers and expose their tools to the supervisor as native tools, with `static` (bearer/header) auth or `oauth` (MCP-native OAuth 2.1: discovery + DCR + PKCE, vault-backed per-conversation tokens).

**Architecture:** A new `instance_mcp_servers` table + store mirrors `instance_channels`. In `prepareSupervisor`, for each enabled server we build a `@ai-sdk/mcp` client (static → `headers`; oauth → a vault-backed `OAuthClientProvider`), call `client.tools()`, and synthesize namespaced `mcp__<slug>__<tool>` tools like the existing `agent:{slug}` block. On `UnauthorizedError` we instead synthesize a `mcp__<slug>__connect` tool carrying the stashed authorize URL. A new `GET /mcp/oauth/callback` (near-clone of the existing OAuth callback) completes the flow. Clients are closed after the turn.

**Tech Stack:** TypeScript ESM, NestJS 11, Drizzle ORM (PostgreSQL), Vercel AI SDK v6 (`ai@6`), `@ai-sdk/mcp@^1.0`, Zod, Vitest. Web: Next.js 16 + shadcn/ui.

**Design spec:** `docs/superpowers/specs/2026-07-20-mcp-client-support-design.md` (read it first).

## Global Constraints

- **ESM only** — all relative imports end in `.js`; named exports only (no default exports).
- **Files ≤400 lines, functions ≤30 lines.** Split by responsibility.
- **Pin `@ai-sdk/mcp@^1.0`** (latest 1.x). NEVER `2.x` — it pulls `@ai-sdk/provider@4` and breaks typecheck (`ai@6` is on provider@3).
- **Branded identifiers:** `instance_mcp_servers` is a uuid-FK table → its store fns take `InstanceUuid`. Controllers resolve slug→instance via `findInstanceOrFail(slug)` (returns `.id`). Never pass a plain `string` to a branded param.
- **NestJS DI:** every constructor param in an `@Injectable`/`@Controller` needs an explicit `@Inject(...)` (tsx has no `emitDecoratorMetadata`).
- **Secrets:** never log/audit/return a token or client secret. Reuse `maskSensitiveConfig` (responses) and `stripSensitiveKeys` (export), both keyed on `/(?:token|secret|password|key|credential)/i`.
- **Migrations:** write incremental SQL by hand (no snapshots). Next number is `0071`. Add a matching `_journal.json` entry.
- **No `process.env`** outside `config.ts` (Zod-validated).
- **Commit** after every green step. English conventional-commit messages. Every commit needs a `Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>` trailer (write the message to a file and `git commit -F`).
- **Test command:** `npm run test:unit -w @polyant/engine -- <path>` (Vitest). Typecheck: `npm run typecheck -w @polyant/engine`.

---

### Task 1: Add the `@ai-sdk/mcp` dependency

**Files:**
- Modify: `packages/engine/package.json` (dependencies)
- Modify: `package-lock.json` (generated)

**Interfaces:**
- Produces: the `@ai-sdk/mcp` module resolvable at `^1.0` (exports `createMCPClient`, `auth`, `UnauthorizedError`, types `OAuthClientProvider`, `OAuthClientInformation`, `OAuthTokens`, `MCPTransportConfig`).

- [ ] **Step 1: Add the pinned dependency**

Run from the repo root (installs the latest 1.x, writes `^1.0.x` into `packages/engine/package.json`):
```bash
npm install --workspace @polyant/engine "@ai-sdk/mcp@^1.0"
```

- [ ] **Step 2: Verify the resolved version is 1.x (provider@3)**

Run:
```bash
node -e "console.log(require('@ai-sdk/mcp/package.json').version, '->', require('@ai-sdk/mcp/package.json').dependencies['@ai-sdk/provider'])"
```
Expected: a `1.0.x` version and `@ai-sdk/provider` on `3.x`. If it resolved to `2.x`, run `npm install --workspace @polyant/engine "@ai-sdk/mcp@^1.0.64"` and re-check.

- [ ] **Step 3: Typecheck still passes**

Run: `npm run typecheck -w @polyant/engine`
Expected: no errors (the package is installed but not yet imported).

- [ ] **Step 4: Commit**

```bash
git add packages/engine/package.json package-lock.json
git commit -F <msg-file>   # "chore(mcp): add @ai-sdk/mcp@^1.0 dependency"
```

---

### Task 2: Migration + schema for `instance_mcp_servers`

**Files:**
- Create: `packages/engine/src/database/migrations/0071_instance_mcp_servers.sql`
- Modify: `packages/engine/src/database/migrations/meta/_journal.json`
- Create: `packages/engine/src/instances/mcp-servers.schema.ts`

**Interfaces:**
- Produces: `instanceMcpServers` Drizzle table with columns `id, instanceId, slug, name, url, authMode, enabled, config, createdAt, updatedAt`; unique `(instanceId, slug)`.

- [ ] **Step 1: Write the migration SQL**

Create `packages/engine/src/database/migrations/0071_instance_mcp_servers.sql`:
```sql
CREATE TABLE IF NOT EXISTS "instance_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"slug" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"url" text NOT NULL,
	"auth_mode" varchar(20) DEFAULT 'static' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_instance_mcp_server_slug" UNIQUE("instance_id","slug")
);
--> statement-breakpoint
ALTER TABLE "instance_mcp_servers" ADD CONSTRAINT "instance_mcp_servers_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instance_mcp_servers_instance" ON "instance_mcp_servers" ("instance_id");
```

- [ ] **Step 2: Register the migration in the journal**

Edit `packages/engine/src/database/migrations/meta/_journal.json`: append to `entries` (the last existing entry is `idx: 63, tag: "0070_oauth_states"`):
```json
{ "idx": 64, "version": "7", "when": 1753228800000, "tag": "0071_instance_mcp_servers", "breakpoints": true }
```
(`when` is any fixed epoch-ms; the value above is fine.)

- [ ] **Step 3: Write the Drizzle schema**

Create `packages/engine/src/instances/mcp-servers.schema.ts`:
```ts
import { pgTable, uuid, varchar, text, boolean, timestamp, unique, index } from "drizzle-orm/pg-core";
import { instances } from "./schema.js";

export const instanceMcpServers = pgTable(
  "instance_mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id").notNull().references(() => instances.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 50 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    url: text("url").notNull(),
    authMode: varchar("auth_mode", { length: 20 }).notNull().default("static"),
    enabled: boolean("enabled").notNull().default(true),
    config: text("config").notNull(), // encrypted JSON
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_instance_mcp_server_slug").on(table.instanceId, table.slug),
    index("idx_instance_mcp_servers_instance").on(table.instanceId),
  ],
);
```

- [ ] **Step 4: Apply the migration and typecheck**

Run: `npm run db:migrate -w @polyant/engine && npm run typecheck -w @polyant/engine`
Expected: migration applies (table created); typecheck passes.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/database/migrations/0071_instance_mcp_servers.sql packages/engine/src/database/migrations/meta/_journal.json packages/engine/src/instances/mcp-servers.schema.ts
git commit -F <msg-file>   # "feat(mcp): add instance_mcp_servers table + schema"
```

---

### Task 3: Store + Zod config schemas

**Files:**
- Create: `packages/engine/src/instances/mcp-servers.store.ts`
- Test: `packages/engine/src/instances/mcp-servers.store.test.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt` from `../crypto/index.js`; `instanceMcpServers` (Task 2); `InstanceUuid` from `./identifiers.js`.
- Produces:
  - `type McpAuthMode = "static" | "oauth"`.
  - `interface McpServerRecord { id: string; slug: string; name: string; url: string; authMode: McpAuthMode; enabled: boolean; config: McpServerConfig }`.
  - `type McpServerConfig` = discriminated by mode: static `{ auth: { type:"bearer"; token:string } | { type:"header"; headerName:string; token:string }; allowList?: string[] }`; oauth `{ scopes?: string[]; staticClient?: { clientId:string; clientSecret?:string }; dcrClient?: Record<string,unknown>; allowList?: string[] }`.
  - `mcpServerConfigSchema` (Zod, mode-aware validator: `(authMode, config) => parsed`).
  - `setMcpServer(instanceId: InstanceUuid, input: { slug; name; url; authMode; enabled; config }): Promise<void>`
  - `getMcpServer(instanceId: InstanceUuid, slug: string): Promise<McpServerRecord | null>`
  - `listMcpServers(instanceId: InstanceUuid): Promise<McpServerRecord[]>`
  - `listEnabledMcpServers(instanceId: InstanceUuid): Promise<McpServerRecord[]>`
  - `deleteMcpServer(instanceId: InstanceUuid, slug: string): Promise<void>`
  - `mergeMcpServerConfig(instanceId: InstanceUuid, slug: string, patch: Record<string, unknown>): Promise<void>` — read-modify-write of the encrypted `config` (used by the OAuth provider to persist `dcrClient`).

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/instances/mcp-servers.store.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceUuid } from "./identifiers.js";

const rows: any[] = [];
vi.mock("../database/client.js", () => ({
  db: {
    insert: () => ({ values: (v: any) => ({ onConflictDoUpdate: ({ set }: any) => { const i = rows.findIndex((r) => r.instanceId === v.instanceId && r.slug === v.slug); if (i >= 0) rows[i] = { ...rows[i], ...set }; else rows.push(v); } }) }),
    select: () => ({ from: () => ({ where: () => rows.slice() }) }),
    delete: () => ({ where: () => { rows.length = 0; } }),
  },
}));

const { setMcpServer, listEnabledMcpServers, mcpServerConfigSchema } = await import("./mcp-servers.store.js");
const IID = asInstanceUuid("11111111-1111-1111-1111-111111111111");

describe("mcp-servers.store", () => {
  beforeEach(() => { rows.length = 0; });

  it("should_reject_static_config_without_auth", () => {
    expect(() => mcpServerConfigSchema("static", { allowList: [] })).toThrow();
  });

  it("should_accept_oauth_config_with_only_scopes", () => {
    expect(mcpServerConfigSchema("oauth", { scopes: ["repo"] })).toMatchObject({ scopes: ["repo"] });
  });

  it("should_encrypt_and_round_trip_a_static_server", async () => {
    await setMcpServer(IID, {
      slug: "github", name: "GitHub", url: "https://mcp.example.com", authMode: "static", enabled: true,
      config: { auth: { type: "bearer", token: "secret-token" } },
    });
    const enabled = await listEnabledMcpServers(IID);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].config).toMatchObject({ auth: { type: "bearer", token: "secret-token" } });
    // the persisted row's config column must NOT be plaintext
    expect(rows[0].config).not.toContain("secret-token");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- mcp-servers.store`
Expected: FAIL — `Cannot find module './mcp-servers.store.js'`.

- [ ] **Step 3: Implement the store**

Create `packages/engine/src/instances/mcp-servers.store.ts`:
```ts
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database/client.js";
import { instanceMcpServers } from "./mcp-servers.schema.js";
import { encrypt, decrypt } from "../crypto/index.js";
import { type InstanceUuid } from "./identifiers.js";

export const MCP_AUTH_MODES = ["static", "oauth"] as const;
export type McpAuthMode = (typeof MCP_AUTH_MODES)[number];

const staticConfigSchema = z.object({
  auth: z.union([
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
    z.object({ type: z.literal("header"), headerName: z.string().min(1), token: z.string().min(1) }),
  ]),
  allowList: z.array(z.string()).optional(),
});

const oauthConfigSchema = z.object({
  scopes: z.array(z.string()).optional(),
  staticClient: z.object({ clientId: z.string().min(1), clientSecret: z.string().optional() }).optional(),
  dcrClient: z.record(z.unknown()).optional(),
  allowList: z.array(z.string()).optional(),
});

export type McpServerConfig = z.infer<typeof staticConfigSchema> | z.infer<typeof oauthConfigSchema>;

/** Validate a config blob against its auth mode; throws ZodError on mismatch. */
export function mcpServerConfigSchema(authMode: McpAuthMode, config: unknown): McpServerConfig {
  return authMode === "static" ? staticConfigSchema.parse(config) : oauthConfigSchema.parse(config);
}

export interface McpServerRecord {
  id: string;
  slug: string;
  name: string;
  url: string;
  authMode: McpAuthMode;
  enabled: boolean;
  config: McpServerConfig;
}

function decryptConfig(encrypted: string): Record<string, unknown> {
  if (!encrypted || !encrypted.includes(":")) return {};
  try {
    return JSON.parse(decrypt(encrypted)) as Record<string, unknown>;
  } catch (err) {
    console.error("[McpServers] Failed to decrypt config:", err);
    return {};
  }
}

function toRecord(row: typeof instanceMcpServers.$inferSelect): McpServerRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    authMode: row.authMode as McpAuthMode,
    enabled: row.enabled,
    config: decryptConfig(row.config) as McpServerConfig,
  };
}

export interface SetMcpServerInput {
  slug: string;
  name: string;
  url: string;
  authMode: McpAuthMode;
  enabled: boolean;
  config: Record<string, unknown>;
}

export async function setMcpServer(instanceId: InstanceUuid, input: SetMcpServerInput): Promise<void> {
  mcpServerConfigSchema(input.authMode, input.config); // validate before encrypt
  const encryptedConfig = encrypt(JSON.stringify(input.config));
  await db
    .insert(instanceMcpServers)
    .values({ instanceId, slug: input.slug, name: input.name, url: input.url, authMode: input.authMode, enabled: input.enabled, config: encryptedConfig })
    .onConflictDoUpdate({
      target: [instanceMcpServers.instanceId, instanceMcpServers.slug],
      set: { name: input.name, url: input.url, authMode: input.authMode, enabled: input.enabled, config: encryptedConfig, updatedAt: new Date() },
    });
}

export async function getMcpServer(instanceId: InstanceUuid, slug: string): Promise<McpServerRecord | null> {
  const rows = await db.select().from(instanceMcpServers).where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.slug, slug)));
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listMcpServers(instanceId: InstanceUuid): Promise<McpServerRecord[]> {
  const rows = await db.select().from(instanceMcpServers).where(eq(instanceMcpServers.instanceId, instanceId));
  return rows.map(toRecord);
}

export async function listEnabledMcpServers(instanceId: InstanceUuid): Promise<McpServerRecord[]> {
  const rows = await db.select().from(instanceMcpServers).where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.enabled, true)));
  return rows.map(toRecord);
}

export async function deleteMcpServer(instanceId: InstanceUuid, slug: string): Promise<void> {
  await db.delete(instanceMcpServers).where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.slug, slug)));
}

/** Read-modify-write of the encrypted config (used to persist DCR client info). */
export async function mergeMcpServerConfig(instanceId: InstanceUuid, slug: string, patch: Record<string, unknown>): Promise<void> {
  const current = await getMcpServer(instanceId, slug);
  if (!current) return;
  const merged = { ...(current.config as Record<string, unknown>), ...patch };
  await db
    .update(instanceMcpServers)
    .set({ config: encrypt(JSON.stringify(merged)), updatedAt: new Date() })
    .where(and(eq(instanceMcpServers.instanceId, instanceId), eq(instanceMcpServers.slug, slug)));
}
```
(Add `import { and, eq } from "drizzle-orm"` already present; `db.update` is used in `mergeMcpServerConfig` — the test mock covers `insert`/`select`/`delete`; add a trivial `update` mock returning `{ set: () => ({ where: () => {} }) }` to the test's `db` object so the store imports cleanly, or leave `mergeMcpServerConfig` untested here — it is covered in Task 6's provider test.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- mcp-servers.store`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/instances/mcp-servers.store.ts packages/engine/src/instances/mcp-servers.store.test.ts
git commit -F <msg-file>   # "feat(mcp): store + zod config schemas for mcp servers"
```

---

### Task 4: Management-audit action + target constants

**Files:**
- Modify: `packages/engine/src/management-audit/management-audit-logger.ts`
- Test: `packages/engine/src/management-audit/management-audit-logger.test.ts` (extend existing if present, else create)

**Interfaces:**
- Produces: `ManagementAuditAction.McpServerWrite`, `ManagementAuditAction.McpServerDelete`, `ManagementAuditTarget.McpServer` constants.

- [ ] **Step 1: Write the failing test**

Create/extend `packages/engine/src/management-audit/management-audit-logger.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ManagementAuditAction, ManagementAuditTarget } from "./management-audit-logger.js";

describe("management-audit mcp constants", () => {
  it("should_expose_mcp_server_action_and_target", () => {
    expect(ManagementAuditAction.McpServerWrite).toBe("mcp_server.write");
    expect(ManagementAuditAction.McpServerDelete).toBe("mcp_server.delete");
    expect(ManagementAuditTarget.McpServer).toBe("mcp_server");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- management-audit-logger`
Expected: FAIL — `McpServerWrite` is `undefined`.

- [ ] **Step 3: Add the constants**

In `packages/engine/src/management-audit/management-audit-logger.ts`, add to the `ManagementAuditAction` const map: `McpServerWrite: "mcp_server.write", McpServerDelete: "mcp_server.delete",` and to `ManagementAuditTarget`: `McpServer: "mcp_server",`. (These are `as const` maps; the value-type unions widen automatically.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- management-audit-logger`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/management-audit/management-audit-logger.ts packages/engine/src/management-audit/management-audit-logger.test.ts
git commit -F <msg-file>   # "feat(mcp): management-audit constants for mcp server mutations"
```

---

### Task 5: Management API controller (`mcp-servers.controller.ts`) + module registration

**Files:**
- Create: `packages/engine/src/server/instances/mcp-servers.controller.ts`
- Modify: `packages/engine/src/server/server.module.ts` (import + `controllers` array)
- Test: `packages/engine/src/server/instances/mcp-servers.controller.test.ts`

**Interfaces:**
- Consumes: store (Task 3), `findInstanceOrFail`/`maskSensitiveConfig` from `./instance-helpers.js`, `createManagementAuditLogger`/`ManagementAuditAction`/`ManagementAuditTarget`/`toManagementAuditActor` (Task 4), `@CurrentUser`, `asInstanceUuid`.
- Produces: routes `GET/PUT/DELETE /api/instances/:slug/mcp-servers[/:serverSlug]` and `POST /api/instances/:slug/mcp-servers/test`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/server/instances/mcp-servers.controller.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = { setMcpServer: vi.fn(), getMcpServer: vi.fn(), listMcpServers: vi.fn(), deleteMcpServer: vi.fn() };
vi.mock("../../instances/mcp-servers.store.js", () => store);
vi.mock("./instance-helpers.js", () => ({
  findInstanceOrFail: vi.fn(async () => ({ id: "uuid-1", slug: "acme" })),
  maskSensitiveConfig: (c: Record<string, unknown>) => c,
}));
vi.mock("../../management-audit/management-audit-logger.js", () => ({
  createManagementAuditLogger: () => ({ log: vi.fn() }),
  ManagementAuditAction: { McpServerWrite: "mcp_server.write", McpServerDelete: "mcp_server.delete" },
  ManagementAuditTarget: { McpServer: "mcp_server" },
  toManagementAuditActor: () => undefined,
}));

const { McpServersController } = await import("./mcp-servers.controller.js");

describe("McpServersController", () => {
  beforeEach(() => Object.values(store).forEach((f) => f.mockReset()));

  it("should_mask_tokens_in_list_response", async () => {
    store.listMcpServers.mockResolvedValue([{ slug: "gh", name: "GH", url: "u", authMode: "static", enabled: true, config: { auth: { type: "bearer", token: "shh" } } }]);
    const c = new McpServersController();
    const out = await c.list("acme");
    // maskSensitiveConfig is mocked to identity here; assert the store was scoped by resolved uuid
    expect(store.listMcpServers).toHaveBeenCalledWith("uuid-1");
    expect(out).toHaveLength(1);
  });

  it("should_reject_invalid_body", async () => {
    const c = new McpServersController();
    await expect(c.set("acme", "gh", { name: "", url: "", authMode: "static", enabled: true, config: {} } as any)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- mcp-servers.controller`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

Create `packages/engine/src/server/instances/mcp-servers.controller.ts` — mirror `instance-secrets.controller.ts` (audit + `@CurrentUser`) and `instance-channels.controller.ts` (mask + slug→uuid). Key shape:
```ts
import { Controller, Get, Put, Delete, Post, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission, Permission } from "../../authz/index.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { asInstanceUuid } from "../../instances/identifiers.js";
import { findInstanceOrFail, maskSensitiveConfig } from "./instance-helpers.js";
import { setMcpServer, getMcpServer, listMcpServers, deleteMcpServer, MCP_AUTH_MODES, mcpServerConfigSchema } from "../../instances/mcp-servers.store.js";
import { createManagementAuditLogger, ManagementAuditAction, ManagementAuditTarget, toManagementAuditActor } from "../../management-audit/management-audit-logger.js";
import { testMcpConnection } from "../../agents/tools/mcp/mcp-test.js"; // Task 7

import { assertSafeMcpUrl } from "../../agents/tools/mcp/mcp-url-guard.js"; // Task 5 Step 3a

const setBodySchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  authMode: z.enum(MCP_AUTH_MODES),
  enabled: z.boolean(),
  config: z.record(z.unknown()),
});

@Controller("api/instances")
export class McpServersController {
  private readonly auditLogger = createManagementAuditLogger();

  @Get(":slug/mcp-servers")
  @RequirePermission(Permission.CHANNEL_READ)
  async list(@Param("slug") slug: string) {
    const inst = await findInstanceOrFail(slug);
    const servers = await listMcpServers(asInstanceUuid(inst.id));
    return servers.map((s) => ({ ...s, config: maskSensitiveConfig(s.config as Record<string, unknown>) }));
  }

  @Put(":slug/mcp-servers/:serverSlug")
  @RequirePermission(Permission.CHANNEL_WRITE)
  async set(@Param("slug") slug: string, @Param("serverSlug") serverSlug: string, @Body() body: unknown, @CurrentUser() user?: AuthenticatedUser) {
    const parsed = setBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    const inst = await findInstanceOrFail(slug);
    // merge masked (••••) values back to existing to preserve unchanged secrets
    const existing = await getMcpServer(asInstanceUuid(inst.id), serverSlug);
    const merged: Record<string, unknown> = { ...(existing?.config as Record<string, unknown> ?? {}) };
    for (const [k, v] of Object.entries(parsed.data.config)) {
      if (typeof v === "string" && v.startsWith("••••")) continue;
      merged[k] = v;
    }
    mcpServerConfigSchema(parsed.data.authMode, merged); // validate the effective config
    await setMcpServer(asInstanceUuid(inst.id), { slug: serverSlug, name: parsed.data.name, url: parsed.data.url, authMode: parsed.data.authMode, enabled: parsed.data.enabled, config: merged });
    this.auditLogger.log({ action: ManagementAuditAction.McpServerWrite, actor: toManagementAuditActor(user), targetType: ManagementAuditTarget.McpServer, targetId: serverSlug, metadata: { instanceSlug: slug } });
    return { ok: true };
  }

  @Delete(":slug/mcp-servers/:serverSlug")
  @RequirePermission(Permission.CHANNEL_WRITE)
  async remove(@Param("slug") slug: string, @Param("serverSlug") serverSlug: string, @CurrentUser() user?: AuthenticatedUser) {
    const inst = await findInstanceOrFail(slug);
    await deleteMcpServer(asInstanceUuid(inst.id), serverSlug);
    this.auditLogger.log({ action: ManagementAuditAction.McpServerDelete, actor: toManagementAuditActor(user), targetType: ManagementAuditTarget.McpServer, targetId: serverSlug, metadata: { instanceSlug: slug } });
    return { ok: true };
  }

  @Post(":slug/mcp-servers/test")
  @RequirePermission(Permission.CHANNEL_WRITE)
  async test(@Param("slug") slug: string, @Body() body: unknown) {
    const parsed = setBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.message);
    await findInstanceOrFail(slug);
    return testMcpConnection({ url: parsed.data.url, authMode: parsed.data.authMode, config: parsed.data.config });
  }
}
```
Note: the controller imports `testMcpConnection` from Task 7. If executing tasks strictly in order, stub `mcp-test.ts` with `export async function testMcpConnection() { return { ok: true }; }` now and complete it in Task 7 — or reorder so Task 7 precedes this one. The plan lists Task 7 after; add the stub here and delete it in Task 7.

Both `set` and `test` MUST call `assertSafeMcpUrl(parsed.data.url)` right after `safeParse` succeeds (before any store write or connect), to satisfy the SSRF requirement (spec §7).

- [ ] **Step 3a: SSRF url guard (with test)**

Create `packages/engine/src/agents/tools/mcp/mcp-url-guard.ts`:
```ts
import { BadRequestException } from "@nestjs/common";
import { config } from "../../../config.js";

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fe80:)|(^172\.(1[6-9]|2\d|3[01])\.)/i;

/** Reject non-http(s) schemes and, in production, private/loopback/link-local hosts (SSRF). */
export function assertSafeMcpUrl(raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BadRequestException("Invalid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BadRequestException("URL must be http(s)");
  const isProd = (config.server as { nodeEnv?: string }).nodeEnv === "production" || process.env.NODE_ENV === "production"; // CONVENTION-EXCEPTION: env gate only
  if (isProd) {
    if (u.protocol !== "https:") throw new BadRequestException("HTTPS required in production");
    if (PRIVATE_HOST.test(u.hostname)) throw new BadRequestException("Private/loopback hosts are not allowed");
  }
}
```
Create `packages/engine/src/agents/tools/mcp/mcp-url-guard.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("../../../config.js", () => ({ config: { server: { nodeEnv: "production" } } }));
const { assertSafeMcpUrl } = await import("./mcp-url-guard.js");

describe("assertSafeMcpUrl", () => {
  it("should_reject_private_host_in_prod", () => {
    expect(() => assertSafeMcpUrl("https://10.0.0.5/mcp")).toThrow();
    expect(() => assertSafeMcpUrl("http://localhost:4000/mcp")).toThrow();
    expect(() => assertSafeMcpUrl("https://192.168.1.9/mcp")).toThrow();
  });
  it("should_allow_public_https", () => {
    expect(() => assertSafeMcpUrl("https://mcp.example.com/sse")).not.toThrow();
  });
  it("should_reject_non_http_scheme", () => {
    expect(() => assertSafeMcpUrl("file:///etc/passwd")).toThrow();
  });
});
```
Run: `npm run test:unit -w @polyant/engine -- mcp-url-guard`
Expected: PASS (3 tests). Then add `assertSafeMcpUrl(parsed.data.url)` to the controller's `set` and `test` handlers immediately after the `safeParse` guard.

- [ ] **Step 4: Register in the module**

In `packages/engine/src/server/server.module.ts`: import `McpServersController` near the other instance controllers (~line 17), and add `McpServersController` to the flat `controllers: [ ... ]` array (~line 69).

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test:unit -w @polyant/engine -- mcp-servers.controller && npm run typecheck -w @polyant/engine`
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/server/instances/mcp-servers.controller.ts packages/engine/src/server/instances/mcp-servers.controller.test.ts packages/engine/src/server/server.module.ts packages/engine/src/agents/tools/mcp/mcp-test.ts packages/engine/src/agents/tools/mcp/mcp-url-guard.ts packages/engine/src/agents/tools/mcp/mcp-url-guard.test.ts
git commit -F <msg-file>   # "feat(mcp): management API for mcp servers (CRUD + test + SSRF guard)"
```

---

### Task 6: Vault-backed `OAuthClientProvider`

**Files:**
- Create: `packages/engine/src/agents/tools/mcp/mcp-oauth-provider.ts`
- Test: `packages/engine/src/agents/tools/mcp/mcp-oauth-provider.test.ts`

**Interfaces:**
- Consumes: `principal-secrets.store.js` (`getPrincipalSecret`/`setPrincipalSecret`), `oauth-states.store.js` (`createOAuthState`/`consumeOAuthState`), `mcp-servers.store.js` (`mergeMcpServerConfig`), `config.server.baseUrl`/`port`.
- Produces:
  - `mcpRedirectUrl(): string` — `<baseUrl>/mcp/oauth/callback`.
  - `interface McpOAuthProviderDeps { instanceUuid: InstanceUuid; conversationId: string; serverSlug: string; config: McpServerConfig }`.
  - `class McpVaultOAuthProvider implements OAuthClientProvider` with a public `pendingAuthorizeUrl?: string`.
  - `makeMcpOAuthProvider(deps): McpVaultOAuthProvider`.

- [ ] **Step 0: Verify the SDK's auth() call order**

Read `node_modules/@ai-sdk/mcp/dist/index.mjs` around the `async function auth(` definition and confirm the sequence of `provider.state()` / `saveState()` / `saveCodeVerifier()` / `saveClientInformation()` / `redirectToAuthorization()` calls (authorize phase) and `codeVerifier()` / `storedState()` / `clientInformation()` (exchange phase). Adjust the method bodies below to match. (This plan assumes: authorize phase calls `saveClientInformation`→`saveCodeVerifier`→`saveState`→`redirectToAuthorization`; exchange phase reads `clientInformation`→`codeVerifier`→`storedState`.)

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/agents/tools/mcp/mcp-oauth-provider.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceUuid } from "../../../instances/identifiers.js";

const vault = new Map<string, string>();
vi.mock("../../../conversations/principal-secrets.store.js", () => ({
  setPrincipalSecret: vi.fn(async (scopeKey: string, _iid: unknown, key: string, value: string) => { vault.set(`${scopeKey}:${key}`, value); }),
  getPrincipalSecret: vi.fn(async (scopeKey: string, key: string) => { const v = vault.get(`${scopeKey}:${key}`); return v ? { value: v, expiresAt: null } : undefined; }),
}));
const states: any[] = [];
vi.mock("../../../server/oauth/oauth-states.store.js", () => ({
  createOAuthState: vi.fn(async (row: any) => { states.push(row); }),
  consumeOAuthState: vi.fn(async (s: string) => states.find((r) => r.state === s) ?? null),
}));
const merged: any[] = [];
vi.mock("../../../instances/mcp-servers.store.js", () => ({ mergeMcpServerConfig: vi.fn(async (_i: unknown, slug: string, patch: any) => { merged.push({ slug, patch }); }) }));
vi.mock("../../../config.js", () => ({ config: { server: { baseUrl: "https://polyant.test", port: 4000 } } }));

const { makeMcpOAuthProvider, mcpRedirectUrl } = await import("./mcp-oauth-provider.js");
const deps = { instanceUuid: asInstanceUuid("iid"), conversationId: "conv-1", serverSlug: "gh", config: {} as any };

describe("McpVaultOAuthProvider", () => {
  beforeEach(() => { vault.clear(); states.length = 0; merged.length = 0; });

  it("should_build_redirect_url", () => {
    expect(mcpRedirectUrl()).toBe("https://polyant.test/mcp/oauth/callback");
  });

  it("should_round_trip_tokens_via_vault_per_conversation", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveTokens({ access_token: "at", token_type: "bearer" } as any);
    expect(await p.tokens()).toMatchObject({ access_token: "at" });
    expect(vault.has("conv-1:mcp_gh_tokens")).toBe(true);
  });

  it("should_persist_dcr_client_to_server_config", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveClientInformation!({ client_id: "cid" } as any);
    expect(merged[0]).toMatchObject({ slug: "gh", patch: { dcrClient: { client_id: "cid" } } });
  });

  it("should_capture_authorize_url_and_persist_state", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveState!("nonce-123");
    await p.redirectToAuthorization(new URL("https://gh.test/authorize?x=1"));
    expect(p.pendingAuthorizeUrl).toBe("https://gh.test/authorize?x=1");
    expect(states[0]).toMatchObject({ state: "nonce-123", conversationId: "conv-1", provider: "mcp:gh" });
  });

  it("should_read_client_from_staticClient_when_no_dcr", async () => {
    const p = makeMcpOAuthProvider({ ...deps, config: { staticClient: { clientId: "static-cid", clientSecret: "sek" } } as any });
    expect(await p.clientInformation()).toMatchObject({ client_id: "static-cid", client_secret: "sek" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- mcp-oauth-provider`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Create `packages/engine/src/agents/tools/mcp/mcp-oauth-provider.ts`:
```ts
import type { OAuthClientProvider, OAuthClientInformation, OAuthTokens } from "@ai-sdk/mcp";
import { config } from "../../../config.js";
import { type InstanceUuid } from "../../../instances/identifiers.js";
import { getPrincipalSecret, setPrincipalSecret } from "../../../conversations/principal-secrets.store.js";
import { createOAuthState, consumeOAuthState } from "../../../server/oauth/oauth-states.store.js";
import { mergeMcpServerConfig } from "../../../instances/mcp-servers.store.js";
import type { McpServerConfig } from "../../../instances/mcp-servers.store.js";

export function mcpRedirectUrl(): string {
  const base = config.server.baseUrl ?? `http://localhost:${config.server.port}`;
  return `${base.replace(/\/+$/, "")}/mcp/oauth/callback`;
}

export interface McpOAuthProviderDeps {
  instanceUuid: InstanceUuid;
  conversationId: string;
  serverSlug: string;
  config: McpServerConfig;
}

const tokensKey = (slug: string) => `mcp_${slug}_tokens`;
const verifierKey = (slug: string) => `mcp_${slug}_verifier`;

export class McpVaultOAuthProvider implements OAuthClientProvider {
  public pendingAuthorizeUrl?: string;
  private stateValue?: string;

  constructor(private readonly deps: McpOAuthProviderDeps) {}

  get redirectUrl(): string {
    return mcpRedirectUrl();
  }

  get clientMetadata() {
    const cfg = this.deps.config as { scopes?: string[] };
    return {
      redirect_uris: [this.redirectUrl],
      client_name: `Polyant (${this.deps.serverSlug})`,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: (this.deps.config as any).staticClient?.clientSecret ? "client_secret_post" : "none",
      scope: cfg.scopes?.join(" "),
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const cfg = this.deps.config as { dcrClient?: OAuthClientInformation; staticClient?: { clientId: string; clientSecret?: string } };
    if (cfg.dcrClient) return cfg.dcrClient;
    if (cfg.staticClient) return { client_id: cfg.staticClient.clientId, client_secret: cfg.staticClient.clientSecret };
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformation): Promise<void> {
    await mergeMcpServerConfig(this.deps.instanceUuid, this.deps.serverSlug, { dcrClient: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = await getPrincipalSecret(this.deps.conversationId, tokensKey(this.deps.serverSlug));
    return row ? (JSON.parse(row.value) as OAuthTokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await setPrincipalSecret(this.deps.conversationId, this.deps.instanceUuid, tokensKey(this.deps.serverSlug), JSON.stringify(tokens));
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await setPrincipalSecret(this.deps.conversationId, this.deps.instanceUuid, verifierKey(this.deps.serverSlug), verifier);
  }

  async codeVerifier(): Promise<string> {
    const row = await getPrincipalSecret(this.deps.conversationId, verifierKey(this.deps.serverSlug));
    if (!row) throw new Error(`Missing PKCE verifier for mcp:${this.deps.serverSlug}`);
    return row.value;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthorizeUrl = authorizationUrl.toString();
  }

  async saveState(state: string): Promise<void> {
    this.stateValue = state;
    await createOAuthState({ state, conversationId: this.deps.conversationId, instanceId: this.deps.instanceUuid, provider: `mcp:${this.deps.serverSlug}`, codeVerifier: null });
  }

  async storedState(): Promise<string | undefined> {
    return this.stateValue;
  }

  /** Set by the callback after consuming the state row, so storedState() matches. */
  setStoredState(state: string): void {
    this.stateValue = state;
  }
}

export function makeMcpOAuthProvider(deps: McpOAuthProviderDeps): McpVaultOAuthProvider {
  return new McpVaultOAuthProvider(deps);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- mcp-oauth-provider`
Expected: PASS (5 tests). If Step 0 revealed a different call order (e.g. the SDK calls `state()` instead of `saveState()`), add a `state()` method generating + persisting a nonce and adjust the test.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agents/tools/mcp/mcp-oauth-provider.ts packages/engine/src/agents/tools/mcp/mcp-oauth-provider.test.ts
git commit -F <msg-file>   # "feat(mcp): vault-backed OAuthClientProvider for MCP-native auth"
```

---

### Task 7: MCP tool builder (connect + synth + connect-tool + teardown) and `testMcpConnection`

**Files:**
- Create: `packages/engine/src/agents/tools/mcp/mcp-tools.ts`
- Create: `packages/engine/src/agents/tools/mcp/mcp-test.ts` (replace the Task-5 stub)
- Test: `packages/engine/src/agents/tools/mcp/mcp-tools.test.ts`

**Interfaces:**
- Consumes: `createMCPClient`, `UnauthorizedError` from `@ai-sdk/mcp`; `tool as aiTool` from `ai`; `listEnabledMcpServers` (Task 3); `makeMcpOAuthProvider` (Task 6); `toModelToolName` from `../registry.js`.
- Produces:
  - `interface McpBuildResult { tools: Record<string, Tool>; close: () => Promise<void> }`.
  - `buildMcpTools(opts: { instanceUuid: InstanceUuid; conversationId?: string; allowListFilter?: boolean }): Promise<McpBuildResult>`.
  - `testMcpConnection(opts: { url: string; authMode: McpAuthMode; config: Record<string, unknown> }): Promise<{ ok: boolean; tools?: string[]; requiresOAuth?: boolean; error?: string }>`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/agents/tools/mcp/mcp-tools.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceUuid } from "../../../instances/identifiers.js";

class FakeUnauthorized extends Error {}
const createMCPClient = vi.fn();
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient, UnauthorizedError: FakeUnauthorized }));
const servers: any[] = [];
vi.mock("../../../instances/mcp-servers.store.js", () => ({ listEnabledMcpServers: vi.fn(async () => servers) }));
vi.mock("./mcp-oauth-provider.js", () => ({ makeMcpOAuthProvider: () => ({ pendingAuthorizeUrl: "https://gh.test/authorize" }) }));

const { buildMcpTools } = await import("./mcp-tools.js");
const IID = asInstanceUuid("iid");

describe("buildMcpTools", () => {
  beforeEach(() => { servers.length = 0; createMCPClient.mockReset(); });

  it("should_namespace_and_wrap_static_server_tools", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    createMCPClient.mockResolvedValue({ tools: async () => ({ create_issue: { description: "d", inputSchema: {}, execute: async () => "ok" } }), close: vi.fn() });
    const { tools, close } = await buildMcpTools({ instanceUuid: IID, conversationId: "c1" });
    expect(Object.keys(tools)).toContain("mcp__gh__create_issue");
    await close();
  });

  it("should_synthesize_connect_tool_on_unauthorized", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });
    createMCPClient.mockRejectedValue(new FakeUnauthorized());
    const { tools } = await buildMcpTools({ instanceUuid: IID, conversationId: "c1" });
    expect(Object.keys(tools)).toContain("mcp__gh__connect");
    const out = await (tools["mcp__gh__connect"] as any).execute({});
    expect(out).toMatchObject({ status: "action_required", url: "https://gh.test/authorize" });
  });

  it("should_skip_oauth_server_when_no_conversationId", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "oauth", config: {} });
    const { tools } = await buildMcpTools({ instanceUuid: IID, conversationId: undefined });
    expect(Object.keys(tools)).toHaveLength(0);
    expect(createMCPClient).not.toHaveBeenCalled();
  });

  it("should_skip_dead_server_without_throwing", async () => {
    servers.push({ slug: "gh", url: "https://x", authMode: "static", config: { auth: { type: "bearer", token: "t" } } });
    createMCPClient.mockRejectedValue(new Error("connection refused"));
    const { tools } = await buildMcpTools({ instanceUuid: IID, conversationId: "c1" });
    expect(Object.keys(tools)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- mcp-tools`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder + test helper**

Create `packages/engine/src/agents/tools/mcp/mcp-tools.ts`:
```ts
import { tool as aiTool, type Tool } from "ai";
import { createMCPClient, UnauthorizedError } from "@ai-sdk/mcp";
import { type InstanceUuid } from "../../../instances/identifiers.js";
import { toModelToolName } from "../registry.js";
import { listEnabledMcpServers, type McpServerRecord } from "../../../instances/mcp-servers.store.js";
import { makeMcpOAuthProvider } from "./mcp-oauth-provider.js";

export interface McpBuildResult {
  tools: Record<string, Tool>;
  close: () => Promise<void>;
}

function staticHeaders(server: McpServerRecord): Record<string, string> {
  const auth = (server.config as { auth?: { type: string; token: string; headerName?: string } }).auth;
  if (!auth) return {};
  return auth.type === "bearer" ? { Authorization: `Bearer ${auth.token}` } : { [auth.headerName!]: auth.token };
}

function connectTool(server: McpServerRecord, url: string): Tool {
  return aiTool({
    description: `Connect the ${server.name} account to enable its tools. Call this when the user asks for something that needs ${server.name} and you are not yet connected.`,
    inputSchema: { type: "object", properties: {} } as never,
    execute: async () => ({ status: "action_required", message: `Open this link to connect ${server.name}, authorize, then ask again.`, url }),
  });
}

export async function buildMcpTools(opts: { instanceUuid: InstanceUuid; conversationId?: string }): Promise<McpBuildResult> {
  const tools: Record<string, Tool> = {};
  const clients: Array<{ close: () => Promise<void> }> = [];
  const servers = await listEnabledMcpServers(opts.instanceUuid);

  for (const server of servers) {
    if (server.authMode === "oauth" && !opts.conversationId) continue; // no stable conversation (room/webhook)
    const allowList = (server.config as { allowList?: string[] }).allowList;
    const provider = server.authMode === "oauth" && opts.conversationId
      ? makeMcpOAuthProvider({ instanceUuid: opts.instanceUuid, conversationId: opts.conversationId, serverSlug: server.slug, config: server.config })
      : undefined;
    const transport = provider
      ? { type: "http" as const, url: server.url, authProvider: provider as never }
      : { type: "http" as const, url: server.url, headers: staticHeaders(server) };

    try {
      const client = await createMCPClient({ transport });
      const toolSet = await client.tools();
      for (const [toolName, t] of Object.entries(toolSet)) {
        if (allowList && !allowList.includes(toolName)) continue;
        tools[toModelToolName(`mcp:${server.slug}:${toolName}`)] = t as Tool;
      }
      clients.push(client);
    } catch (e) {
      if (e instanceof UnauthorizedError && provider?.pendingAuthorizeUrl) {
        tools[toModelToolName(`mcp:${server.slug}:connect`)] = connectTool(server, provider.pendingAuthorizeUrl);
      } else {
        console.warn(`[mcp] server '${server.slug}' unavailable this turn:`, e instanceof Error ? e.message : e);
      }
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
```
Create `packages/engine/src/agents/tools/mcp/mcp-test.ts` (delete the Task-5 stub content, keep the export name):
```ts
import { createMCPClient, UnauthorizedError } from "@ai-sdk/mcp";
import type { McpAuthMode } from "../../../instances/mcp-servers.store.js";

export async function testMcpConnection(opts: { url: string; authMode: McpAuthMode; config: Record<string, unknown> }): Promise<{ ok: boolean; tools?: string[]; requiresOAuth?: boolean; error?: string }> {
  try {
    if (opts.authMode === "oauth") {
      // token-less connect: a 401 that resolves to discovery means the endpoint is a valid MCP OAuth server
      return { ok: true, requiresOAuth: true };
    }
    const auth = (opts.config as { auth?: { type: string; token: string; headerName?: string } }).auth;
    const headers = auth ? (auth.type === "bearer" ? { Authorization: `Bearer ${auth.token}` } : { [auth.headerName!]: auth.token }) : {};
    const client = await createMCPClient({ transport: { type: "http", url: opts.url, headers } });
    const toolSet = await client.tools();
    await client.close();
    return { ok: true, tools: Object.keys(toolSet) };
  } catch (e) {
    if (e instanceof UnauthorizedError) return { ok: true, requiresOAuth: true };
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -w @polyant/engine -- mcp-tools`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: no errors. (If the `inputSchema: {} as never` cast fights the SDK's `Tool` typing, use an empty Zod object `z.object({})` instead.)

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agents/tools/mcp/mcp-tools.ts packages/engine/src/agents/tools/mcp/mcp-test.ts packages/engine/src/agents/tools/mcp/mcp-tools.test.ts
git commit -F <msg-file>   # "feat(mcp): buildMcpTools + testMcpConnection"
```

---

### Task 8: Wire MCP tools into the supervisor + close on turn end

**Files:**
- Modify: `packages/engine/src/agents/supervisor/index.ts` (`prepareSupervisor`, `SupervisorContext`, `supervise`, `superviseStream`)
- Test: `packages/engine/src/agents/supervisor/mcp-wiring.test.ts`

**Interfaces:**
- Consumes: `buildMcpTools` (Task 7).
- Produces: MCP tools merged into `ctx.tools`; `close()` invoked after `chat()` (in `supervise`) and off the `completed` promise (in `superviseStream`).

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/agents/supervisor/mcp-wiring.test.ts` — assert `buildMcpTools` result is merged and `close` is called after a non-streamed turn. (Mock `buildMcpTools` to return `{ tools: { mcp__gh__x: {...} }, close: vi.fn() }`, mock `chat` to resolve; call `supervise` with a minimal input; assert `close` called once and the tool present in the `chat` call's `tools`.) Follow the mocking style already used in `packages/engine/src/agents/supervisor/index.test.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- mcp-wiring`
Expected: FAIL (close not called / tool absent).

- [ ] **Step 3: Implement the wiring**

In `prepareSupervisor` (where `buildTools` is called, ~`index.ts:456`), after building the core tools:
```ts
const mcp = await buildMcpTools({ instanceUuid, conversationId: input.conversationId });
const tools = { ...coreTools, ...mcp.tools };
```
Add `mcpClose: mcp.close` to the returned `SupervisorContext` (extend the interface at `index.ts:378-386` with `mcpClose: () => Promise<void>`).
In `supervise` (`index.ts:570-617`), wrap the `chat()` call:
```ts
try {
  const response = await chat({...}, {...});
  return {...};
} finally {
  await ctx.mcpClose();
}
```
In `superviseStream` (`index.ts:505-568`), attach cleanup to the `completed` promise so clients outlive the function but still close when the stream settles:
```ts
const completed = stream.response.then(...).finally(() => ctx.mcpClose());
```
Import `buildMcpTools` at the top from `../tools/mcp/mcp-tools.js`.

- [ ] **Step 4: Run to verify it passes + full supervisor suite**

Run: `npm run test:unit -w @polyant/engine -- supervisor`
Expected: PASS (new test + no regressions in `index.test.ts`).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @polyant/engine`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agents/supervisor/index.ts packages/engine/src/agents/supervisor/mcp-wiring.test.ts
git commit -F <msg-file>   # "feat(mcp): wire mcp tools into supervisor with per-turn teardown"
```

---

### Task 9: MCP OAuth callback controller

**Files:**
- Create: `packages/engine/src/server/oauth/mcp-oauth-callback.controller.ts`
- Modify: `packages/engine/src/server/server.module.ts` (register controller)
- Test: `packages/engine/src/server/oauth/mcp-oauth-callback.controller.test.ts`

**Interfaces:**
- Consumes: `consumeOAuthState` (states store), `getMcpServer` (store), `makeMcpOAuthProvider` (Task 6), `auth` from `@ai-sdk/mcp`, `resolveInstanceId`/`asInstanceUuid`.
- Produces: `GET /mcp/oauth/callback?code&state` → exchanges code, `saveTokens`, HTML page.

- [ ] **Step 1: Write the failing test**

Create the test: mock `consumeOAuthState` to return `{ state, conversationId: "c1", instanceId: "iid", provider: "mcp:gh" }`, mock `getMcpServer` to return an oauth server, mock `@ai-sdk/mcp`'s `auth` to resolve `"AUTHORIZED"`, mock `makeMcpOAuthProvider`. Call the controller's handler with `code`, `state`, and a fake `res` (`{ type: () => res, send: vi.fn(), status: () => res }`). Assert `auth` was called with `{ serverUrl, authorizationCode: code, callbackState: state }` and a success page was sent. Add a case: unknown state → 400, nothing sent to `auth`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- mcp-oauth-callback`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

Create `packages/engine/src/server/oauth/mcp-oauth-callback.controller.ts` — mirror `oauth-callback.controller.ts` (same `escapeHtml`/`page` helpers, `@Controller("mcp/oauth")`, `@Public() @Get("callback")`):
```ts
import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { auth } from "@ai-sdk/mcp";
import { Public } from "../../auth/decorators/public.decorator.js";
import { consumeOAuthState } from "./oauth-states.store.js";
import { getMcpServer } from "../../instances/mcp-servers.store.js";
import { makeMcpOAuthProvider } from "../../agents/tools/mcp/mcp-oauth-provider.js";
import { asInstanceUuid } from "../../instances/identifiers.js";

function escapeHtml(s: string): string { /* copy from oauth-callback.controller.ts */ return s; }
function page(title: string, body: string): string { /* copy from oauth-callback.controller.ts */ return ""; }

@Controller("mcp/oauth")
export class McpOAuthCallbackController {
  @Public()
  @Get("callback")
  async callback(@Query("code") code: string, @Query("state") state: string, @Res() res: Response) {
    if (!code || !state) { res.status(400).type("html").send(page("Errore", "Parametri mancanti")); return; }
    const pending = await consumeOAuthState(state);
    if (!pending || !pending.provider.startsWith("mcp:")) { res.status(400).type("html").send(page("Errore", "Stato non valido o scaduto")); return; }
    const serverSlug = pending.provider.slice("mcp:".length);
    const instanceUuid = asInstanceUuid(pending.instanceId);
    const server = await getMcpServer(instanceUuid, serverSlug);
    if (!server) { res.status(404).type("html").send(page("Errore", "Server MCP non trovato")); return; }
    try {
      const provider = makeMcpOAuthProvider({ instanceUuid, conversationId: pending.conversationId, serverSlug, config: server.config });
      provider.setStoredState(state);
      await auth(provider, { serverUrl: server.url, authorizationCode: code, callbackState: state });
      res.type("html").send(page(`${server.name} collegato ✅`, "Torna alla chat e continua."));
    } catch (e) {
      res.status(502).type("html").send(page("Errore", e instanceof Error ? e.message : "Scambio token fallito"));
    }
  }
}
```
(Copy the real `escapeHtml`/`page` bodies verbatim from `oauth-callback.controller.ts:22-31`.)
Register `McpOAuthCallbackController` in `server.module.ts` (import + `controllers` array).

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npm run test:unit -w @polyant/engine -- mcp-oauth-callback && npm run typecheck -w @polyant/engine`
Expected: PASS + no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/server/oauth/mcp-oauth-callback.controller.ts packages/engine/src/server/oauth/mcp-oauth-callback.controller.test.ts packages/engine/src/server/server.module.ts
git commit -F <msg-file>   # "feat(mcp): MCP-native OAuth callback controller"
```

---

### Task 10: Export / import (`mcpServers[]`, bundle v1.2)

**Files:**
- Modify: `packages/engine/src/instances/export.schema.ts`
- Modify: `packages/engine/src/instances/export.service.ts`
- Modify: `packages/engine/src/instances/import.service.ts`
- Test: extend `packages/engine/src/instances/export.service.test.ts` / `import.service.test.ts` (whichever exist)

**Interfaces:**
- Consumes: store (Task 3), `stripSensitiveKeys`.
- Produces: bundle `version` accepts `"1.2"`; `instance.mcpServers[]` exported (secrets stripped) and imported (re-enable gating).

- [ ] **Step 1: Write the failing test**

Extend the export test: an instance with a static MCP server exports an `mcpServers` array whose config has NO `token`/`auth.token`, and the bundle `version` is `"1.2"`. Extend the import test: importing that bundle re-creates the server disabled with an `mcp_server_credentials` warning (static, since its stripped config fails the schema); an oauth server (config `{ scopes }`) imports enabled.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -w @polyant/engine -- export.service import.service`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `export.schema.ts`: bump `INSTANCE_BUNDLE_VERSION` to `"1.2"`; add `z.literal("1.2")` to the envelope `version` union; add `exportMcpServerSchema = z.object({ slug: z.string(), name: z.string(), url: z.string(), authMode: z.string(), enabled: z.boolean(), config: z.record(z.unknown()).default({}) })`; add `mcpServers: z.array(exportMcpServerSchema).default([])` to the instance schema.
- `export.service.ts`: add `exportMcpServers(instanceId)` returning rows with `config: stripSensitiveKeys(decryptedConfig)`; include in the exported instance object.
- `import.service.ts`: add `importMcpServers(tx, instanceId, servers, warnings)` mirroring `importChannels` — for `static`, re-enable only if the stripped config passes `mcpServerConfigSchema("static", config)` (it won't, since `auth.token` was stripped) → push `{ type: "mcp_server_credentials", message: ... }`; for `oauth`, enable as-is. Add `"mcp_server_credentials"` to the `ImportWarning.type` union. Call `importMcpServers` in both `importNewInstance` and `importOverwriteInstance` (with a `tx.delete(instanceMcpServers)` first in overwrite).

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `npm run test:unit -w @polyant/engine -- export.service import.service && npm run typecheck -w @polyant/engine`
Expected: PASS + no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/instances/export.schema.ts packages/engine/src/instances/export.service.ts packages/engine/src/instances/import.service.ts packages/engine/src/instances/*.test.ts
git commit -F <msg-file>   # "feat(mcp): export/import mcp servers (bundle v1.2)"
```

---

### Task 11: Web — MCP tab

**Files:**
- Create: `packages/web/src/app/(admin)/instances/[slug]/mcp/` page + a `McpServersTab` component (follow the existing Channels tab layout).
- Modify: `packages/web/src/lib/api.ts` (add MCP server client fns)
- Modify: the instance-detail tab nav to add "MCP".

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/instances/:slug/mcp-servers`, `POST .../test`.

- [ ] **Step 1: Add API client fns**

In `packages/web/src/lib/api.ts`, add `listMcpServers(slug)`, `setMcpServer(slug, serverSlug, body)`, `deleteMcpServer(slug, serverSlug)`, `testMcpServer(slug, body)` mirroring the channels client fns.

- [ ] **Step 2: Build the tab component**

Create `McpServersTab` (invoke the `frontend-design-system` skill for tokens/components): a list of servers (name, url, authMode badge, enabled toggle, edit/delete); an add/edit dialog with fields name, url, `authMode` select (`static`/`oauth`); for `static` an auth-type select (bearer/header) + token; for `oauth` optional scopes + an "advanced" disclosure for a pre-registered client id/secret; an optional allow-list; a "Test connection" button showing discovered tool names (static) or "requires authorization at chat time" (oauth). Use the Channels tab as the visual template.

- [ ] **Step 3: Wire the tab into the instance-detail nav**

Add an "MCP" entry to the instance tab navigation.

- [ ] **Step 4: Manual verify + web build**

Run: `npm run build:web`
Expected: build succeeds. Manually: create a static server pointing at a mock MCP endpoint, confirm it lists + persists + masks the token; create an oauth server, confirm the connect flow surfaces a link in the playground.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/...
git commit -F <msg-file>   # "feat(mcp): web MCP tab (server CRUD + test)"
```

---

### Task 12: Docs + CLAUDE.md knowledge capture

**Files:**
- Modify: `CLAUDE.md` (add an MCP-client convention bullet)
- Create/Modify: `docs/` entry if an MCP user doc is warranted.

- [ ] **Step 1: Add a CLAUDE.md bullet**

Document: the two auth modes, MCP-native OAuth reuses `principal_secrets` (tokens per-conversation) + DCR client per-(instance,server) in the encrypted config, the `mcp__<slug>__connect` synthetic-tool bridge, the `@ai-sdk/mcp@^1.0` pin, per-turn client lifecycle, and the Room limitation.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md docs/
git commit -F <msg-file>   # "docs(mcp): document MCP client support conventions"
```

---

## Final verification

- [ ] `npm run typecheck -w @polyant/engine` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run test:unit -w @polyant/engine` — all green.
- [ ] `npm run build:web` — succeeds.
- [ ] Live smoke: a static MCP server exposes tools in the playground; an oauth server surfaces a connect link, and after authorizing the real tools appear on the next turn.
