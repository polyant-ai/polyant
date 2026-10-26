// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

vi.mock("../instances/instance-meta.js", () => ({
  resolveInstanceMeta: async (slug: string) => (slug === "ghost" ? undefined : { id: "x", slug, name: `Agent ${slug}`, icon: null }),
}));

import { allTenantsScope } from "../authz/scope-filter.js";
import { Permission } from "../authz/permissions.js";
import { decodeCursor, encodeCursor, readMonitor, readMonitorDetail } from "./monitor.read.js";
import { registerMonitorSource } from "./monitor.registry.js";
import { DEFAULT_MONITOR_LEVEL, type MonitorItem, type MonitorSource, type MonitorSourceQuery } from "./monitor.types.js";

const scope = allTenantsScope("test");
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = (sec: number) => `2026-01-01T00:00:${String(sec).padStart(2, "0")}.000000Z`;

function item(type: string, n: number, sec: number, slug = "a"): MonitorItem {
  return {
    id: ID(n),
    type,
    group: "agents",
    time: T(sec),
    agent: { slug, name: slug },
    conversationId: null,
    summary: `${type} ${n}`,
    outcome: "ok",
    durationMs: null,
  };
}

/** A source over a fixed, newest-first array that honours `before` and `limit` like a SQL source does. */
function fakeSource(type: string, permission: MonitorSource["permission"], rows: MonitorItem[]): MonitorSource {
  const seen: MonitorSourceQuery[] = [];
  return Object.assign(
    {
      type,
      group: "agents",
      permission,
      retentionDays: (days: number) => days,
      async list(q: MonitorSourceQuery) {
        seen.push(q);
        return rows
          .filter((r) => !q.before || r.time < q.before.time || (r.time === q.before.time && r.id < q.before.id))
          .slice(0, q.limit);
      },
      async detail(id: string) {
        const row = rows.find((r) => r.id === id);
        return row ? { ...row, error: null, sections: [] } : null;
      },
    },
    { seen },
  );
}

const allowAll = async () => true;
const base = { scope, canRead: allowAll, telemetryRetentionDays: 90 };

describe("readMonitor", () => {
  it("interleaves types by time and pages without losing or repeating a row", async () => {
    registerMonitorSource(fakeSource("t_a", Permission.AUDIT_LOG_READ, [item("t_a", 1, 50), item("t_a", 2, 30), item("t_a", 3, 10)]));
    registerMonitorSource(fakeSource("t_b", Permission.TASK_READ, [item("t_b", 4, 40), item("t_b", 5, 20), item("t_b", 6, 5)]));

    const first = await readMonitor({ ...base, types: ["t_a", "t_b"], limit: 4 });
    expect(first.items.map((i) => i.summary)).toEqual(["t_a 1", "t_b 4", "t_a 2", "t_b 5"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await readMonitor({ ...base, types: ["t_a", "t_b"], limit: 4, cursor: decodeCursor(first.nextCursor!) });
    expect(second.items.map((i) => i.summary)).toEqual(["t_a 3", "t_b 6"]);
    expect(second.nextCursor).toBeNull();
  });

  it("orders rows that share a time by id, so a cursor between them resumes exactly", async () => {
    registerMonitorSource(fakeSource("t_c", Permission.AUDIT_LOG_READ, [item("t_c", 9, 7), item("t_c", 8, 7), item("t_c", 7, 7)]));
    const first = await readMonitor({ ...base, types: ["t_c"], limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([ID(9), ID(8)]);
    const second = await readMonitor({ ...base, types: ["t_c"], limit: 2, cursor: decodeCursor(first.nextCursor!) });
    expect(second.items.map((i) => i.id)).toEqual([ID(7)]);
  });

  it("leaves a type out, without failing the list, when the caller lacks its permission", async () => {
    registerMonitorSource(fakeSource("t_d", Permission.AUDIT_LOG_READ, [item("t_d", 1, 1)]));
    registerMonitorSource(fakeSource("t_e", Permission.CONVERSATION_READ, [item("t_e", 2, 2)]));
    const page = await readMonitor({
      ...base,
      canRead: async (p) => p !== Permission.AUDIT_LOG_READ,
      types: ["t_d", "t_e"],
    });
    expect(page.items.map((i) => i.type)).toEqual(["t_e"]);
    expect(page.types.map((t) => t.type)).toContain("t_e");
    expect(page.types.map((t) => t.type)).not.toContain("t_d");
  });

  it("passes the filters to every selected source and none to an unselected one", async () => {
    const wanted = fakeSource("t_f", Permission.AUDIT_LOG_READ, []);
    const other = fakeSource("t_g", Permission.AUDIT_LOG_READ, []);
    registerMonitorSource(wanted);
    registerMonitorSource(other);
    await readMonitor({ ...base, types: ["t_f"], agent: "a", outcome: "error", search: "x", limit: 10 });
    expect((wanted as unknown as { seen: MonitorSourceQuery[] }).seen[0]).toMatchObject({ agent: "a", outcome: "error", search: "x", limit: 11 });
    expect((other as unknown as { seen: MonitorSourceQuery[] }).seen).toHaveLength(0);
  });

  it("names agents once per page and falls back to the slug for an unknown agent", async () => {
    registerMonitorSource(fakeSource("t_h", Permission.AUDIT_LOG_READ, [item("t_h", 1, 2, "a"), item("t_h", 2, 1, "ghost")]));
    const page = await readMonitor({ ...base, types: ["t_h"] });
    expect(page.items.map((i) => i.agent)).toEqual([
      { slug: "a", name: "Agent a" },
      { slug: "ghost", name: "ghost" },
    ]);
  });

  it("reports retention per type from the platform setting", async () => {
    registerMonitorSource({ ...fakeSource("t_i", Permission.CONVERSATION_READ, []), retentionDays: () => null });
    const page = await readMonitor({ ...base, types: ["t_i"], telemetryRetentionDays: 30 });
    expect(page.types.find((t) => t.type === "t_i")?.retentionDays).toBeNull();
    registerMonitorSource(fakeSource("t_j", Permission.AUDIT_LOG_READ, []));
    expect((await readMonitor({ ...base, types: ["t_j"], telemetryRetentionDays: 30 })).types.find((t) => t.type === "t_j")?.retentionDays).toBe(30);
  });
});

describe("levels", () => {
  const leveled = (type: string, levels: MonitorSource["levels"], permissionAt?: MonitorSource["permissionAt"]) =>
    ({ ...fakeSource(type, Permission.AUDIT_LOG_READ, [item(type, 1, 1)]), levels, permissionAt }) as MonitorSource & { seen: MonitorSourceQuery[] };

  it("lists a type only in the Monitors it declares, the default one when it declares none", async () => {
    registerMonitorSource(leveled("l_default", undefined));
    registerMonitorSource(leveled("l_wide", ["wide"]));
    registerMonitorSource(leveled("l_all", [DEFAULT_MONITOR_LEVEL, "wide", "widest"]));
    const types = async (level: string) =>
      (await readMonitor({ ...base, level, types: ["l_default", "l_wide", "l_all"] })).types.map((t) => t.type).filter((t) => t.startsWith("l_"));
    expect(await types(DEFAULT_MONITOR_LEVEL)).toEqual(["l_default", "l_all"]);
    expect(await types("wide")).toEqual(["l_wide", "l_all"]);
    expect(await types("widest")).toEqual(["l_all"]);
    // No level named is the default Monitor.
    expect((await readMonitor({ ...base, types: ["l_default"] })).types.map((t) => t.type)).toContain("l_default");
  });

  it("asks for the permission a type names at that level, and its own elsewhere", async () => {
    registerMonitorSource(leveled("l_perm", [DEFAULT_MONITOR_LEVEL, "wide"], { wide: Permission.TASK_READ }));
    const asked: string[] = [];
    const canRead = async (p: string) => (asked.push(p), p === Permission.TASK_READ);
    expect((await readMonitor({ ...base, level: "wide", canRead, types: ["l_perm"] })).items).toHaveLength(1);
    expect((await readMonitor({ ...base, level: DEFAULT_MONITOR_LEVEL, canRead, types: ["l_perm"] })).items).toHaveLength(0);
    expect(asked).toContain(Permission.TASK_READ);
    expect(asked).toContain(Permission.AUDIT_LOG_READ);
  });

  it("tells each source which level it is read at", async () => {
    const source = leveled("l_seen", ["wide"]);
    registerMonitorSource(source);
    await readMonitor({ ...base, level: "wide", types: ["l_seen"] });
    expect(source.seen[0]).toMatchObject({ level: "wide" });
  });

  it("does not look up an agent for a row about no agent", async () => {
    registerMonitorSource(fakeSource("l_noagent", Permission.AUDIT_LOG_READ, [item("l_noagent", 1, 1, "")]));
    const page = await readMonitor({ ...base, types: ["l_noagent"] });
    expect(page.items[0]?.agent).toEqual({ slug: "", name: "" });
  });

  it("answers a detail null at a level the type is not in", async () => {
    registerMonitorSource(leveled("l_detail", ["wide"]));
    expect(await readMonitorDetail("l_detail", ID(1), scope, allowAll, "wide")).not.toBeNull();
    expect(await readMonitorDetail("l_detail", ID(1), scope, allowAll, DEFAULT_MONITOR_LEVEL)).toBeNull();
  });
});

describe("readMonitorDetail", () => {
  it("answers null for an unreadable type exactly like an unknown row", async () => {
    registerMonitorSource(fakeSource("t_k", Permission.AUDIT_LOG_READ, [item("t_k", 1, 1)]));
    expect(await readMonitorDetail("t_k", ID(1), scope, allowAll)).not.toBeNull();
    expect(await readMonitorDetail("t_k", ID(1), scope, async () => false)).toBeNull();
    expect(await readMonitorDetail("t_k", ID(2), scope, allowAll)).toBeNull();
    expect(await readMonitorDetail("no_such_type", ID(1), scope, allowAll)).toBeNull();
  });
});

describe("cursor", () => {
  it("round-trips and rejects anything it did not write", () => {
    const cursor = { time: T(3), id: ID(1) };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor("not-base64-json")).toBeUndefined();
    expect(decodeCursor(Buffer.from(JSON.stringify(["2026-01-01", ID(1)])).toString("base64url"))).toBeUndefined();
    expect(decodeCursor(Buffer.from(JSON.stringify([T(1), "'; drop table x"])).toString("base64url"))).toBeUndefined();
  });
});
