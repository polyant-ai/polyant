// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Monitor read model against a real Postgres: the four built-in types, tenant
 * isolation, the filters, and keyset paging across rows that share a timestamp.
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { orgScope } from "../authz/scope-filter.js";
import { decodeCursor, readMonitor, readMonitorDetail, type MonitorItem } from "./index.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = `itest-mon-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const allowAll = async () => true;
const base = { canRead: allowAll, telemetryRetentionDays: 90 };

interface Tenant {
  orgId: string;
  slug: string;
  taskId: string;
}

async function seedTenant(label: string): Promise<Tenant> {
  const slug = `${MARKER}-${label}`;
  const [{ id: orgId }] = await queryClient<{ id: string }[]>`
    INSERT INTO organizations (slug, name, is_default) VALUES (${slug}, ${`org ${label}`}, false) RETURNING id`;
  const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
    INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${slug}, ${`ws ${label}`}, false) RETURNING id`;
  await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${slug}, ${`Agent ${label}`}, ${workspaceId})`;
  const [{ id: taskId }] = await queryClient<{ id: string }[]>`
    INSERT INTO scheduled_tasks (instance_id, name, prompt, schedule)
    VALUES (${slug}, ${`Task ${label}`}, 'noop', ${JSON.stringify({ type: "interval", everyMs: 60000 })}::jsonb)
    RETURNING id`;
  return { orgId, slug, taskId };
}

async function seedRows(t: Tenant, at: string) {
  await queryClient`
    INSERT INTO tool_audit_logs (instance_id, conversation_id, tool_name, action, details, success, error, duration_ms, output, created_at)
    VALUES (${t.slug}, ${`${t.slug}:web:1`}, 'crm', 'create_contact', ${JSON.stringify({ email: "x@example.com" })}::jsonb, true, null, 12, 'created', ${at}::timestamptz),
           (${t.slug}, null, 'crm', 'delete_contact', ${JSON.stringify({})}::jsonb, false, 'denied by crm', 3, null, ${at}::timestamptz)`;
  await queryClient`
    INSERT INTO scheduled_task_runs (task_id, instance_id, status, trigger_type, started_at, duration_ms, error)
    VALUES (${t.taskId}, ${t.slug}, 'success', 'scheduled', ${at}::timestamptz, 900, null),
           (${t.taskId}, ${t.slug}, 'error', 'manual', ${at}::timestamptz, 40, 'model unavailable')`;
  await queryClient`
    INSERT INTO conversations (conversation_id, instance_id, channel, source, title, created_at)
    VALUES (${`${t.slug}:webhook:abc`}, ${t.slug}, 'webhook', 'webhook', 'Order received', ${at}::timestamptz)`;
  await queryClient`
    INSERT INTO hook_executions (instance_id, conversation_id, hook_id, event, action_type, tool_name, success, duration_ms, args, result, created_at)
    VALUES (${t.slug}, ${`${t.slug}:web:1`}, gen_random_uuid(), 'on_start', 'function', 'notify', true, 5, ${JSON.stringify({ to: "ops" })}::jsonb, 'sent', ${at}::timestamptz)`;
}

async function teardown() {
  const like = `${MARKER}%`;
  await queryClient`DELETE FROM hook_executions WHERE instance_id LIKE ${like}`;
  await queryClient`DELETE FROM tool_audit_logs WHERE instance_id LIKE ${like}`;
  await queryClient`DELETE FROM scheduled_task_runs WHERE instance_id LIKE ${like}`;
  await queryClient`DELETE FROM scheduled_tasks WHERE instance_id LIKE ${like}`;
  await queryClient`DELETE FROM conversations WHERE instance_id LIKE ${like}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${like}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${like}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${like}`;
}

async function readAll(req: Parameters<typeof readMonitor>[0]): Promise<MonitorItem[]> {
  const out: MonitorItem[] = [];
  let cursor = req.cursor;
  for (let i = 0; i < 50; i++) {
    const page = await readMonitor({ ...req, cursor });
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = decodeCursor(page.nextCursor);
  }
  throw new Error("paging did not end");
}

describe.skipIf(!DB_AVAILABLE)("Monitor read model (integration)", () => {
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    await teardown();
    a = await seedTenant("a");
    b = await seedTenant("b");
    await seedRows(a, "2026-03-01T10:00:00.123456Z");
    await seedRows(b, "2026-03-01T10:00:00.123456Z");
  });

  afterAll(async () => {
    await teardown();
  });

  it("lists the four built-in types for the owning organization only", async () => {
    const items = await readAll({ ...base, scope: orgScope(a.orgId), limit: 100 });
    expect(items).toHaveLength(6);
    expect(new Set(items.map((i) => i.agent.slug))).toEqual(new Set([a.slug]));
    expect(new Set(items.map((i) => i.type))).toEqual(new Set(["tool_call", "scheduled_run", "webhook", "hook"]));
    expect(items.every((i) => i.agent.name === "Agent a")).toBe(true);
  });

  it("returns nothing of another organization, even when its agent is named", async () => {
    const items = await readAll({ ...base, scope: orgScope(a.orgId), agent: b.slug, limit: 100 });
    expect(items).toEqual([]);
  });

  it("filters by outcome, and answers a state a type cannot have with no rows of that type", async () => {
    const errors = await readAll({ ...base, scope: orgScope(a.orgId), outcome: "error", limit: 100 });
    expect(errors.map((i) => i.summary).sort()).toEqual(["Task a", "crm: delete_contact"]);
    const running = await readAll({ ...base, scope: orgScope(a.orgId), outcome: "running", limit: 100 });
    expect(running).toEqual([]);
  });

  it("filters by type and by free text", async () => {
    const hooks = await readAll({ ...base, scope: orgScope(a.orgId), types: ["hook"], limit: 100 });
    expect(hooks.map((i) => i.summary)).toEqual(["on_start: notify"]);
    const found = await readAll({ ...base, scope: orgScope(a.orgId), search: "order rec", limit: 100 });
    expect(found.map((i) => i.type)).toEqual(["webhook"]);
    const wildcard = await readAll({ ...base, scope: orgScope(a.orgId), search: "%", limit: 100 });
    expect(wildcard).toEqual([]);
  });

  it("filters by time range", async () => {
    const before = await readAll({ ...base, scope: orgScope(a.orgId), to: new Date("2026-03-01T09:00:00Z"), limit: 100 });
    expect(before).toEqual([]);
    const within = await readAll({ ...base, scope: orgScope(a.orgId), from: new Date("2026-03-01T09:00:00Z"), to: new Date("2026-03-01T11:00:00Z"), limit: 100 });
    expect(within).toHaveLength(6);
  });

  it("pages through rows sharing one timestamp without repeating or dropping any", async () => {
    const one = await readAll({ ...base, scope: orgScope(a.orgId), limit: 1 });
    const all = await readAll({ ...base, scope: orgScope(a.orgId), limit: 100 });
    expect(one.map((i) => `${i.type}:${i.id}`)).toEqual(all.map((i) => `${i.type}:${i.id}`));
    expect(new Set(one.map((i) => `${i.type}:${i.id}`)).size).toBe(6);
    // Microseconds survive: the stored .123456 is what the cursor carries.
    expect(all[0]!.time).toBe("2026-03-01T10:00:00.123456Z");
  });

  it("reads a tool call's arguments and output in the detail", async () => {
    const [call] = (await readMonitor({ ...base, scope: orgScope(a.orgId), types: ["tool_call"], search: "create_contact" })).items;
    const detail = await readMonitorDetail("tool_call", call!.id, orgScope(a.orgId), allowAll);
    expect(detail?.sections).toEqual([
      { key: "arguments", kind: "json", value: { email: "x@example.com" } },
      { key: "output", kind: "text", value: "created" },
    ]);
    expect(detail?.durationMs).toBe(12);
  });

  it("reads a failed run's error in the detail", async () => {
    const [run] = (await readMonitor({ ...base, scope: orgScope(a.orgId), types: ["scheduled_run"], outcome: "error" })).items;
    const detail = await readMonitorDetail("scheduled_run", run!.id, orgScope(a.orgId), allowAll);
    expect(detail?.error).toBe("model unavailable");
    expect(detail?.outcome).toBe("error");
  });

  it("answers null for another organization's row", async () => {
    const [foreign] = (await readMonitor({ ...base, scope: orgScope(b.orgId), types: ["hook"] })).items;
    expect(await readMonitorDetail("hook", foreign!.id, orgScope(b.orgId), allowAll)).not.toBeNull();
    expect(await readMonitorDetail("hook", foreign!.id, orgScope(a.orgId), allowAll)).toBeNull();
    expect(await readMonitorDetail("hook", "not-a-uuid", orgScope(a.orgId), allowAll)).toBeNull();
  });
});
