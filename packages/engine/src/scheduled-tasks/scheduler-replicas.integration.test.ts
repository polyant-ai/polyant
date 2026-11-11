// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The scheduler across replicas, against a real Postgres. Each `SchedulerService` here
 * stands for one engine process: they share nothing but the database, which is the
 * situation of two replicas, or of the old and the new process during a rolling deploy.
 * The pipeline a task runs is replaced by a stub that records which task it ran.
 *
 * The suite's tasks are due since the year 2000, so the oldest-first claim reaches them
 * before any due task another suite may have left on the shared database.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { db, queryClient } from "../database/client.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { scheduledTasks, scheduledTaskRuns } from "./schema.js";
import * as store from "./store.js";
import * as runLog from "./run-log.store.js";
import { schedulerService } from "./scheduler.service.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-sched-replicas";
const SLUG = `${MARKER}-agent`;

type Scheduler = typeof schedulerService;
/** A second engine process: a scheduler of its own, sharing only the database. */
const newReplica = () => new (schedulerService.constructor as new () => Scheduler)();

/** The task ids the stub pipeline ran, in order. */
const ran: string[] = [];
const handler: Parameters<Scheduler["initialize"]>[0] = async (msg) => {
  ran.push(String(msg.metadata?.scheduledTaskId));
  return { text: "" };
};

const created: string[] = [];

/** Tasks due since minute `i` of the year 2000, created in reverse order of due time. */
async function overdueTasks(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const task = await store.create({
      instanceId: asInstanceSlug(SLUG),
      name: `${MARKER}-${i}`,
      prompt: "noop",
      schedule: { type: "interval", everyMs: 3_600_000 },
    });
    await db
      .update(scheduledTasks)
      .set({ nextRunAt: new Date(Date.UTC(2000, 0, 1, 0, i)) })
      .where(eq(scheduledTasks.id, task.id));
    ids[i] = task.id;
    created.push(task.id);
  }
  return ids;
}

async function rows(ids: string[]) {
  const found = await db.select().from(scheduledTasks).where(inArray(scheduledTasks.id, ids));
  return ids.map((id) => found.find((r) => r.id === id)!);
}

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM scheduled_tasks WHERE instance_id = ${SLUG}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("scheduled tasks across replicas (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 's', false) RETURNING id`;
    const [{ id: wsId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, 's', false) RETURNING id`;
    await queryClient`INSERT INTO instances (slug, name, workspace_id) VALUES (${SLUG}, 's', ${wsId})`;
  });

  afterAll(teardown);

  beforeEach(async () => {
    await queryClient`DELETE FROM scheduled_tasks WHERE instance_id = ${SLUG}`;
    created.length = 0;
    ran.length = 0;
  });

  it("two replicas claiming together share the due tasks and never take the same one", async () => {
    const ids = await overdueTasks(6);
    const now = new Date();

    const [a, b] = await Promise.all([
      store.claimDueTasks(now, 3, { leaseTtlMs: 60_000, skip: [] }),
      store.claimDueTasks(now, 3, { leaseTtlMs: 60_000, skip: [] }),
    ]);

    const claimed = [...a, ...b].map((t) => t.id);
    expect(new Set(claimed).size).toBe(6);
    expect(claimed.sort()).toEqual([...ids].sort());
  });

  it("claims the longest overdue tasks first", async () => {
    const ids = await overdueTasks(4);

    const claimed = await store.claimDueTasks(new Date(), 2, { leaseTtlMs: 60_000, skip: [] });

    expect(claimed.map((t) => t.id).sort()).toEqual([ids[0], ids[1]].sort());
  });

  it("does not claim a task another replica has run since the tick read the clock", async () => {
    const [id] = await overdueTasks(1);
    const tickTime = new Date();
    const [first] = await store.claimDueTasks(tickTime, 1, { leaseTtlMs: 60_000, skip: [] });
    expect(first.id).toBe(id);
    await store.markCompleted(id, "conversation-1", tickTime);

    expect((await store.claimDueTasks(tickTime, 1, { leaseTtlMs: 60_000, skip: [] })).map((t) => t.id)).not.toContain(id);
  });

  it("a booting replica runs nothing and pushes no task forward", async () => {
    const ids = await overdueTasks(7);
    const before = (await rows(ids)).map((r) => r.nextRunAt?.getTime());
    const booted = newReplica();
    booted.initialize(handler);

    await booted.start();
    // Anything the boot started in the background has had time to act.
    await new Promise((resolve) => setTimeout(resolve, 300));
    booted.shutdown();

    expect(ran).toEqual([]);
    expect((await rows(ids)).map((r) => r.nextRunAt?.getTime())).toEqual(before);
  });

  it("the tick serves the overdue tasks oldest first, as many as it has slots", async () => {
    const ids = await overdueTasks(5);
    const replica = newReplica();
    replica.initialize(handler);

    await replica.tick();

    expect([...ran].sort()).toEqual([ids[0], ids[1], ids[2]].sort());
  });

  it("a run whose process died is recovered by another replica's tick without counting a failure", async () => {
    const [id] = await overdueTasks(1);
    // The process that claimed it started the run, then died: its lease is past expiry.
    const claim = new Date();
    await store.claimDueTasks(claim, 1, { leaseTtlMs: 60_000, skip: [] });
    const deadRun = await runLog.createRun(id, asInstanceSlug(SLUG), "scheduled");
    await db.update(scheduledTasks).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(scheduledTasks.id, id));

    const survivor = newReplica();
    survivor.initialize(handler);
    await survivor.tick();

    expect(ran).toEqual([id]);
    const [row] = await rows([id]);
    expect(row.lastRunStatus).toBe("success");
    expect(row.consecutiveErrors).toBe(0);
    const [dead] = await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, deadRun!));
    expect(dead.status).toBe("error");
    expect(dead.error).toContain("interrupted");
  });

  it("a run a release without leases left running is recovered after the orphan grace without counting a failure", async () => {
    const [id, young] = await overdueTasks(2);
    // A process of the previous release claimed both and was stopped by the deploy: no
    // lease, started long ago for one, a moment ago for the other. Its deadline has
    // passed, so only the recovery stands between the stale run and a counted failure.
    await db.update(scheduledTasks)
      .set({ lastRunStatus: "running", lastRunAt: null, leaseExpiresAt: null, maxRunMs: 1_000, updatedAt: sql`now() - interval '1 day'` })
      .where(eq(scheduledTasks.id, id));
    await db.update(scheduledTasks)
      .set({ lastRunStatus: "running", lastRunAt: null, leaseExpiresAt: null, updatedAt: sql`now()` })
      .where(eq(scheduledTasks.id, young));

    const survivor = newReplica();
    survivor.initialize(handler);
    await survivor.tick();

    expect(ran).toEqual([id]);
    const [row, youngRow] = await rows([id, young]);
    expect(row.lastRunStatus).toBe("success");
    expect(row.consecutiveErrors).toBe(0);
    expect(youngRow.lastRunStatus).toBe("running");
  });

  it("a run whose lease is live is left to its process", async () => {
    const [id] = await overdueTasks(1);
    const claim = new Date();
    await store.claimDueTasks(claim, 1, { leaseTtlMs: 60_000, skip: [] });

    const other = newReplica();
    other.initialize(handler);
    await other.tick();

    expect(ran).not.toContain(id);
    const [row] = await rows([id]);
    expect(row.lastRunStatus).toBe("running");
    expect(row.lastRunAt?.getTime()).toBe(claim.getTime());
  });
});
