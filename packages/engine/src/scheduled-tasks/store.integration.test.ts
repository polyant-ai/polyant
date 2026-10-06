// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The writes that end a scheduled run, against a real Postgres. A task can be
 * claimed again while an earlier run is still alive: the reaper fails an overdue
 * run and another replica claims the task, or a replica finishes the run another
 * replica read as due a moment ago. The `running` guard alone cannot tell the
 * claims apart, so every write that ends a run names the claim it ends, and a
 * scheduled claim re-checks that the task is still due.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { scheduledTasks } from "./schema.js";
import * as store from "./store.js";
import * as runLog from "./run-log.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const created: string[] = [];

async function newTask(schedule: Parameters<typeof store.create>[0]["schedule"] = { type: "interval", everyMs: 60_000 }) {
  const task = await store.create({
    instanceId: asInstanceSlug(`itest-claims-${Date.now()}`),
    name: "claim race",
    prompt: "noop",
    schedule,
    deleteAfterRun: schedule.type === "one-shot",
  });
  created.push(task.id);
  return task.id;
}

async function claim(id: string): Promise<Date> {
  const claimed = await store.markRunning(id);
  if (!claimed) throw new Error("expected the claim to succeed");
  return claimed;
}

/** The claim as the reaper reads it back from the running row. */
async function readClaim(id: string): Promise<store.RunClaim> {
  const row = (await store.findStuckRunning(new Date(Date.now() + 60_000))).find((t) => t.id === id);
  if (!row) throw new Error("expected a running row");
  return row.lastRunAt;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe.skipIf(!DB_AVAILABLE)("scheduled task run claims (integration)", () => {
  afterAll(async () => {
    for (const id of created) await store.remove(id).catch(() => {});
  });

  it("the reaper does not fail a claim made after the one it read", async () => {
    const id = await newTask();
    const runA = await claim(id);
    const seen = await readClaim(id);

    // Meanwhile: the run finishes and another replica claims the task again.
    await store.markCompleted(id, "conversation-1", runA);
    await tick();
    await claim(id);

    expect(await store.markFailed(id, "orphaned", seen)).toBe(false);

    const row = await store.getById(id);
    expect(row?.lastRunStatus).toBe("running");
    expect(row?.consecutiveErrors).toBe(0);
  });

  it("the reaper fails the claim it read", async () => {
    const id = await newTask();
    await claim(id);
    const seen = await readClaim(id);

    expect(await store.markFailed(id, "orphaned", seen)).toBe(true);

    const row = await store.getById(id);
    expect(row?.lastRunStatus).toBe("error");
    expect(row?.consecutiveErrors).toBe(1);
  });

  it("a late completion of a reaped run leaves the newer claim running", async () => {
    const id = await newTask();
    const runA = await claim(id);
    expect(await store.markFailed(id, "orphaned", await readClaim(id))).toBe(true);
    await tick();
    await claim(id); // run B, on another replica

    expect(await store.markCompleted(id, "conversation-a", runA)).toBeNull();

    const row = await store.getById(id);
    expect(row?.lastRunStatus).toBe("running");
    expect(row?.lastConversationId).toBeNull();
  });

  it("a late failure of a reaped run leaves the newer claim running", async () => {
    const id = await newTask();
    const runA = await claim(id);
    expect(await store.markFailed(id, "orphaned", await readClaim(id))).toBe(true);
    await tick();
    await claim(id);

    expect(await store.markFailed(id, "boom", runA)).toBe(false);
    expect((await store.getById(id))?.lastRunStatus).toBe("running");
  });

  it("an edit while the run is live does not cost the run its completion", async () => {
    const id = await newTask();
    const run = await claim(id);
    await tick();
    await store.update(id, { description: "edited mid-run" });

    expect(await store.markCompleted(id, "conversation-1", run)).toBeInstanceOf(Date);
    expect((await store.getById(id))?.lastRunStatus).toBe("success");
  });

  it("deletes a one-shot task only after the completion that still holds it", async () => {
    const id = await newTask({ type: "one-shot", runAt: new Date(Date.now() - 1_000).toISOString() });
    const completedA = await store.markCompleted(id, "conversation-a", await claim(id));
    expect(completedA).toBeInstanceOf(Date);
    await tick();
    await claim(id); // claimed again before run A got to delete it

    expect(await store.removeAfterRun(id, completedA!)).toBe(false);
    expect(await store.getById(id)).toBeDefined();
  });

  it("deletes a one-shot task after its own completion", async () => {
    const id = await newTask({ type: "one-shot", runAt: new Date(Date.now() - 1_000).toISOString() });
    const completed = await store.markCompleted(id, "conversation-1", await claim(id));

    expect(await store.removeAfterRun(id, completed!)).toBe(true);
    expect(await store.getById(id)).toBeUndefined();
  });

  it("a scheduled claim refuses a task another replica already ran", async () => {
    const id = await newTask({ type: "interval", everyMs: 60 * 60_000 });
    await db.update(scheduledTasks).set({ nextRunAt: new Date(Date.now() - 1_000) }).where(eq(scheduledTasks.id, id));
    // Both replicas read the task as due. One claims it, runs it and completes,
    // which moves next_run_at an hour ahead; then the other's claim lands.
    const first = await store.markRunning(id, { dueBy: new Date() });
    expect(first).toBeInstanceOf(Date);
    await store.markCompleted(id, "conversation-1", first);

    expect(await store.markRunning(id, { dueBy: new Date() })).toBeNull();
    // A manual run is not bound to the schedule.
    expect(await store.markRunning(id)).toBeInstanceOf(Date);
  });
  it("startup recovery does not clear a claim made after the one it read", async () => {
    const id = await newTask();
    const runA = await claim(id);
    const seen = await readClaim(id);

    // Meanwhile run A is closed and a new run B claims the task.
    await store.markCompleted(id, "conversation-1", runA);
    await tick();
    await claim(id);

    expect(await store.clearRunningMarker([{ id, claim: seen }])).toEqual([]);
    expect((await store.getById(id))?.lastRunStatus).toBe("running");
  });

  it("startup recovery clears the claim it read", async () => {
    const id = await newTask();
    await claim(id);
    const seen = await readClaim(id);

    expect(await store.clearRunningMarker([{ id, claim: seen }])).toEqual([id]);
    expect((await store.getById(id))?.lastRunStatus).toBeNull();
  });

  it("closes only the dangling runs it observed, never a run started afterwards", async () => {
    const id = await newTask();
    const task = await store.getById(id);
    const runA = await runLog.createRun(id, asInstanceSlug(task!.instanceId), "scheduled");
    const observed = await runLog.findDanglingRuns([id]);
    // A new run B is created after the observation.
    const runB = await runLog.createRun(id, asInstanceSlug(task!.instanceId), "scheduled");

    expect(observed).toEqual([runA]);
    expect(await runLog.failDanglingRuns(observed, "orphaned")).toBe(1);
    const { runs } = await runLog.listRuns(asInstanceSlug(task!.instanceId), { taskId: id });
    expect(runs.find((r) => r.id === runA)?.status).toBe("error");
    expect(runs.find((r) => r.id === runB)?.status).toBe("running");
  });
});
