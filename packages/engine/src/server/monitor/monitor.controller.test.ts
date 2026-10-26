// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/caller-tenant-scope.js", async () => {
  const { orgScope } = await import("../../authz/scope-filter.js");
  return { callerTenantScope: async () => orgScope("org-1") };
});
vi.mock("../../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: async () => ({ analyticsRetentionDays: 45 }),
}));
vi.mock("../../instances/instance-meta.js", () => ({
  resolveInstanceMeta: async (slug: string) => ({ id: "i", slug, name: slug, icon: null }),
}));

import { Permission, type PermissionKey } from "../../authz/permissions.js";
import type { AuthorizationService } from "../../authz/authorization.service.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { listMonitorSources, registerMonitorSource, type MonitorItem } from "../../monitor/index.js";
import { MonitorController } from "./monitor.controller.js";

const user = { userId: "u1", email: "u@example.com", principalType: "user" } as AuthenticatedUser;

function row(type: string): MonitorItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type,
    group: "agents",
    time: "2026-01-01T00:00:00.000000Z",
    agent: { slug: "a", name: "a" },
    conversationId: null,
    summary: type,
    outcome: "ok",
    durationMs: null,
  };
}

// Replace every built-in source with one that needs the permission it stands for.
for (const s of listMonitorSources()) {
  registerMonitorSource({
    ...s,
    list: async () => [row(s.type)],
    detail: async () => ({ ...row(s.type), error: null, sections: [] }),
  });
}

function controller(held: PermissionKey[], platformAdmin = false) {
  const authz = {
    isPlatformAdmin: async () => platformAdmin,
    can: async (_u: string, _s: unknown, p: PermissionKey) => held.includes(p),
  } as unknown as AuthorizationService;
  return new MonitorController(authz);
}

describe("MonitorController authorization", () => {
  it("a viewer without audit_log:read gets the other types and no tool calls, not an error", async () => {
    const viewer = controller([Permission.CONVERSATION_READ, Permission.TASK_READ, Permission.ANALYTICS_READ]);
    const page = await viewer.list(user);
    expect(page.items.map((i) => i.type).sort()).toEqual(["hook", "scheduled_run", "webhook"]);
    expect(page.types.map((t) => t.type)).not.toContain("tool_call");
  });

  it("an admin sees tool calls too", async () => {
    const admin = controller([Permission.AUDIT_LOG_READ, Permission.CONVERSATION_READ, Permission.TASK_READ]);
    expect((await admin.list(user)).items.map((i) => i.type)).toContain("tool_call");
  });

  it("holding no permission at all yields an empty list", async () => {
    const page = await controller([]).list(user);
    expect(page.items).toEqual([]);
    expect(page.types).toEqual([]);
  });

  it("a platform administrator reads every type, as the guard lets them on the per-type endpoints", async () => {
    expect((await controller([], true).list(user)).items).toHaveLength(4);
  });

  it("refuses the detail of a tool call without audit_log:read with the same 404 as a missing row", async () => {
    const viewer = controller([Permission.CONVERSATION_READ]);
    await expect(viewer.detail(user, "tool_call", row("tool_call").id)).rejects.toMatchObject({ status: 404 });
    await expect(viewer.detail(user, "hook", row("hook").id)).resolves.toMatchObject({ type: "hook" });
  });

  it("reports the telemetry retention and a null for webhook conversations", async () => {
    const page = await controller([Permission.AUDIT_LOG_READ, Permission.CONVERSATION_READ]).list(user);
    const byType = Object.fromEntries(page.types.map((t) => [t.type, t.retentionDays]));
    expect(byType).toMatchObject({ tool_call: 45, hook: 45, webhook: null });
  });

  it("rejects an unknown outcome, a forged cursor and an inverted range with 400", async () => {
    const c = controller([Permission.CONVERSATION_READ]);
    await expect(c.list(user, undefined, undefined, undefined, "exploded")).rejects.toMatchObject({ status: 400 });
    await expect(c.list(user, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "forged")).rejects.toMatchObject({ status: 400 });
    await expect(c.list(user, undefined, undefined, undefined, undefined, "2026-02-01", "2026-01-01")).rejects.toMatchObject({ status: 400 });
  });

  it("narrows to one group, the chips of the panel", async () => {
    const c = controller([Permission.AUDIT_LOG_READ, Permission.CONVERSATION_READ, Permission.TASK_READ]);
    const page = await c.list(user, undefined, "automations");
    expect(page.items.map((i) => i.type).sort()).toEqual(["scheduled_run", "webhook"]);
    expect(page.types).toHaveLength(4);
  });

  it("accepts the type filter as a comma list and as repeated keys", async () => {
    const c = controller([Permission.CONVERSATION_READ, Permission.TASK_READ]);
    expect((await c.list(user, "hook,webhook")).items.map((i) => i.type).sort()).toEqual(["hook", "webhook"]);
    expect((await c.list(user, ["hook", "scheduled_run"])).items.map((i) => i.type).sort()).toEqual(["hook", "scheduled_run"]);
  });
});
