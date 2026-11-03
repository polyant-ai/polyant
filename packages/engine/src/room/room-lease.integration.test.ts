// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Room cycles across replicas, against a real Postgres. Each `RoomScheduler` here
 * stands for one engine process: they share nothing but the database, which is the
 * situation of two replicas, or of the old and the new process during a rolling
 * deploy. The cycle itself is replaced by one that claims and completes events
 * through the real store, under the owner the scheduler hands it, so what is under
 * test is who runs a cycle and what happens to the events it claimed.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lockRoomEventBacklog, resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceUuid } from "../instances/identifiers.js";
import type { RoomConfig } from "./room.store.js";

const { cycles, hold, mockCleanup } = vi.hoisted(() => ({
  /** One entry per cycle that ran: its owner and the event ids it claimed. */
  cycles: [] as Array<{ owner: string; eventIds: string[] }>,
  /** While set, a cycle waits on it after claiming, as a cycle waits on its model call. */
  hold: { promise: null as Promise<void> | null },
  mockCleanup: vi.fn(),
}));

vi.mock("./room-engine.js", () => ({
  executeRoomCycle: async (room: RoomConfig, _slug: string, owner: string) => {
    const store = await import("../webhooks/webhook-backlog.store.js");
    const events = await store.listAndMarkPendingEventsProcessing(room.instanceId, owner);
    if (events.length === 0) return;
    cycles.push({ owner, eventIds: events.map((e) => e.id) });
    if (hold.promise) await hold.promise;
    await store.markEventsCompleted(events.map((e) => e.id), "done", room.instanceId, owner);
  },
}));
// The real cleanup would purge every suite's rows on the shared database.
vi.mock("../analytics/cleanup.js", () => ({ runAnalyticsCleanup: mockCleanup }));
vi.mock("./activity-log.store.js", () => ({ compactActivityLog: vi.fn(async () => {}) }));

const { roomScheduler } = await import("./room-scheduler.js");
const store = await import("../webhooks/webhook-backlog.store.js");

type Scheduler = typeof roomScheduler;
/** A second engine process: a scheduler of its own, sharing only the database. */
const RoomScheduler = roomScheduler.constructor as new () => Scheduler;

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-room-lease";

let instanceId: string;
let definitionId: string;
let releaseBacklog: () => Promise<void>;

const tickOf = (s: Scheduler) => (s as unknown as { tick(): Promise<void> }).tick();
const idle = (...schedulers: Scheduler[]) =>
  vi.waitFor(() => {
    for (const s of schedulers) expect((s as unknown as { running: Set<string> }).running.size).toBe(0);
  });

async function addEvents(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await store.insertEvent(asInstanceUuid(instanceId), definitionId, { n: i });
    if (!id) throw new Error("backlog cap reached");
    ids.push(id);
  }
  return ids;
}

async function statuses(): Promise<Array<{ status: string; claimed_by: string | null }>> {
  return queryClient<Array<{ status: string; claimed_by: string | null }>>`
    SELECT status, claimed_by FROM event_backlog WHERE instance_id = ${instanceId} ORDER BY created_at`;
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM work_leases WHERE key = 'housekeeping:daily' OR key IN (
    SELECT 'room:' || id::text FROM instances WHERE slug LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM event_backlog WHERE instance_id IN (SELECT id FROM instances WHERE slug LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM event_definitions WHERE name LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM event_sources WHERE name LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instance_room WHERE instance_id IN (SELECT id FROM instances WHERE slug LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("room cycles across replicas (integration)", () => {
  beforeAll(async () => {
    releaseBacklog = await lockRoomEventBacklog("exclusive");
    await teardown();
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'r', false) RETURNING id`;
    const [{ id: wsId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, 'r', false) RETURNING id`;
    const [{ id }] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id) VALUES (${MARKER + "-agent"}, 'r', ${wsId}) RETURNING id`;
    instanceId = id;
    await queryClient`INSERT INTO instance_room (instance_id, enabled) VALUES (${instanceId}, true)`;
    const [{ id: srcId }] = await queryClient<{ id: string }[]>`
      INSERT INTO event_sources (instance_id, name, source_type, config, webhook_token)
      VALUES (${instanceId}, ${MARKER + "-src"}, 'webhook', '{}'::jsonb, ${MARKER + "-tok"}) RETURNING id`;
    const [{ id: defId }] = await queryClient<{ id: string }[]>`
      INSERT INTO event_definitions (event_source_id, name, matching_prompt, interpretation_prompt, action)
      VALUES (${srcId}, ${MARKER + "-def"}, 'x', '', 'backlog') RETURNING id`;
    definitionId = defId;
  });

  afterAll(async () => {
    await teardown();
    await releaseBacklog();
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM event_backlog WHERE instance_id = ${instanceId}`;
    await queryClient`DELETE FROM work_leases WHERE key = ${"room:" + instanceId}`;
    cycles.length = 0;
    hold.promise = null;
  });

  it("two replicas ticking together run one cycle, and each event is completed once", async () => {
    await addEvents(3);
    const a = new RoomScheduler();
    const b = new RoomScheduler();

    await Promise.all([tickOf(a), tickOf(b)]);
    await idle(a, b);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].eventIds).toHaveLength(3);
    expect((await statuses()).map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("a replica that ticks during another's cycle does not start a second one", async () => {
    await addEvents(2);
    let finish!: () => void;
    hold.promise = new Promise((resolve) => { finish = resolve; });
    const a = new RoomScheduler();
    const b = new RoomScheduler();

    await tickOf(a);
    await vi.waitFor(() => expect(cycles).toHaveLength(1));
    await addEvents(2);
    await tickOf(b);
    await idle(b);
    expect(cycles).toHaveLength(1);

    finish();
    await idle(a);
    hold.promise = null;
    // The events that arrived during the cycle wait for the next tick, in one cycle.
    await tickOf(b);
    await idle(b);
    expect(cycles.map((c) => c.eventIds.length)).toEqual([2, 2]);
  });

  it("a replica starting during another's cycle leaves that cycle's events alone", async () => {
    await addEvents(3);
    let finish!: () => void;
    hold.promise = new Promise((resolve) => { finish = resolve; });
    const running = new RoomScheduler();
    await tickOf(running);
    await vi.waitFor(() => expect(cycles).toHaveLength(1));

    // A new process boots and ticks while the old one is still in its cycle.
    const booted = new RoomScheduler();
    await tickOf(booted);
    await idle(booted);
    const owner = cycles[0].owner;
    expect(await statuses()).toEqual([
      { status: "processing", claimed_by: owner },
      { status: "processing", claimed_by: owner },
      { status: "processing", claimed_by: owner },
    ]);

    finish();
    await idle(running);
    expect(cycles).toHaveLength(1);
    expect((await statuses()).map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("events of a cycle whose process died go back to pending once its lease expires, and are taken up", async () => {
    await addEvents(2);
    // A process claimed them under its lease, then died: its lease is past expiry.
    await queryClient`INSERT INTO work_leases (key, owner, expires_at)
      VALUES (${"room:" + instanceId}, 'dead-owner', now() - interval '1 second')`;
    await store.listAndMarkPendingEventsProcessing(asInstanceUuid(instanceId), "dead-owner");

    const survivor = new RoomScheduler();
    await tickOf(survivor);
    await idle(survivor);

    expect(cycles).toHaveLength(1);
    expect(cycles[0].owner).not.toBe("dead-owner");
    expect((await statuses()).map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("events of a cycle whose lease is still live stay with it", async () => {
    await addEvents(2);
    await queryClient`INSERT INTO work_leases (key, owner, expires_at)
      VALUES (${"room:" + instanceId}, 'live-owner', now() + interval '1 minute')`;
    await store.listAndMarkPendingEventsProcessing(asInstanceUuid(instanceId), "live-owner");

    const other = new RoomScheduler();
    await tickOf(other);
    await idle(other);

    expect(cycles).toHaveLength(0);
    expect((await statuses()).map((r) => r.claimed_by)).toEqual(["live-owner", "live-owner"]);
  });

  it("a cycle that lost its claim cannot complete the events another cycle now holds", async () => {
    const ids = await addEvents(1);
    await store.listAndMarkPendingEventsProcessing(asInstanceUuid(instanceId), "stale-owner");
    expect(await store.requeueEventsWithoutLiveLease()).toBeGreaterThanOrEqual(1);
    await store.listAndMarkPendingEventsProcessing(asInstanceUuid(instanceId), "current-owner");

    await store.markEventsCompleted(ids, "late", asInstanceUuid(instanceId), "stale-owner");

    expect(await statuses()).toEqual([{ status: "processing", claimed_by: "current-owner" }]);
  });

  it("the daily housekeeping runs once across replicas and later boots", async () => {
    await queryClient`DELETE FROM work_leases WHERE key = 'housekeeping:daily'`;
    mockCleanup.mockClear();
    mockCleanup.mockResolvedValue({
      cutoff: new Date(),
      aiLogsDeleted: 0,
      pipelineTracesDeleted: 0,
      toolAuditLogsDeleted: 0,
      hookExecutionsDeleted: 0,
      scheduledTaskRunsDeleted: 0,
      eventBacklogDeleted: 0,
    });
    const replicas = [new RoomScheduler(), new RoomScheduler()];

    await Promise.all(replicas.map(tickOf));
    await vi.waitFor(async () => {
      const [row] = await queryClient<{ last_done_at: Date | null }[]>`
        SELECT last_done_at FROM work_leases WHERE key = 'housekeeping:daily'`;
      expect(row?.last_done_at).not.toBeNull();
    });
    // A process that boots afterwards finds today's run done.
    await tickOf(new RoomScheduler());
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });
});
