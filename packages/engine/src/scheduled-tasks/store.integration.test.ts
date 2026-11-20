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
import { eq } from "drizzle-orm";
import { db } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import * as store from "./store.js";
import * as runLog from "./run-log.store.js";
import { scheduledTasks } from "./schema.js";

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
  const claimed = await store.markRunning(id, { leaseTtlMs: 60_000 });
  if (!claimed) throw new Error("expected the claim to succeed");
  return claimed;
}

/** The claim as the reaper reads it back from the running row. */
async function readClaim(id: string): Promise<store.RunClaim> {
  const row = (await store.findStuckRunning(new Date(Date.now() + 60_000))).find((t) => t.id === id);
  if (!row) throw new Error("expected a running row");
  return row.lastRunAt;
}

/** Put a task where a test needs it, bypassing the writers' validation. */
async function setRow(id: string, values: Partial<typeof scheduledTasks.$inferInsert>) {
  await db.update(scheduledTasks).set(values).where(eq(scheduledTasks.id, id));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe.skipIf(!DB_AVAILABLE)("scheduled task run claims (integration)", () => {
  afterAll(async () => {
    for (const id of created) await store.remove(id).catch(() => {});
  });

  it("refuses a second claim while the first run holds the task", async () => {
    const id = await newTask();
    await claim(id);

    expect(await store.markRunning(id, { leaseTtlMs: 60_000 })).toBeNull();
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

  it("recovery does not clear a claim made after the one it read", async () => {
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

  it("recovery clears the claim it read", async () => {
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

    expect(observed).toEqual([{ id: runA, taskId: id }]);
    expect(await runLog.failDanglingRuns(observed.map((r) => r.id), "orphaned")).toBe(1);
    const { runs } = await runLog.listRuns(asInstanceSlug(task!.instanceId), { taskId: id });
    expect(runs.find((r) => r.id === runA)?.status).toBe("error");
    expect(runs.find((r) => r.id === runB)?.status).toBe("running");
  });

  it("creates a task enabled unless the caller asks for a disabled one", async () => {
    const enabled = await store.getById(await newTask());
    const disabled = await store.create({
      instanceId: asInstanceSlug(`itest-claims-${Date.now()}`),
      name: "reviewed first",
      prompt: "noop",
      schedule: { type: "interval", everyMs: 60_000 },
      enabled: false,
    });
    created.push(disabled.id);

    expect(enabled?.enabled).toBe(true);
    expect(disabled.enabled).toBe(false);
  });

  it("the claim of a manual run owns the run lease", async () => {
    const id = await newTask();
    const run = await claim(id);

    expect(await store.renewRunLease(id, run, 60_000)).toBe(true);
    expect(await store.renewRunLease(id, new Date(run.getTime() - 1_000), 60_000)).toBe(false);
  });

  it("a failure counts the error, keeps the message and retries after the first backoff step", async () => {
    const id = await newTask();
    const run = await claim(id);
    const before = Date.now();

    expect(await store.markFailed(id, "boom", run)).toBe(true);

    const row = await store.getById(id);
    expect(row).toMatchObject({ lastRunStatus: "error", lastError: "boom", consecutiveErrors: 1, enabled: true });
    // First retry: 30 s after the failure.
    const delay = row!.nextRunAt!.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(30_000 - 1_000);
    expect(delay).toBeLessThan(30_000 + 5_000);
  });

  it("past its retries a failing task goes back to its normal schedule", async () => {
    const id = await newTask({ type: "interval", everyMs: 3_600_000 });
    await setRow(id, { consecutiveErrors: 3, maxRetries: 2 });
    const before = Date.now();

    expect(await store.markFailed(id, "still failing", await claim(id))).toBe(true);

    const row = await store.getById(id);
    expect(row).toMatchObject({ consecutiveErrors: 4, enabled: true });
    // The hourly interval, not a backoff step (the longest is five minutes).
    expect(row!.nextRunAt!.getTime() - before).toBeGreaterThan(30 * 60_000);
  });

  it("the fifth consecutive failure disables the task", async () => {
    const id = await newTask();
    await setRow(id, { consecutiveErrors: 4 });

    expect(await store.markFailed(id, "give up", await claim(id))).toBe(true);

    expect(await store.getById(id)).toMatchObject({
      consecutiveErrors: 5,
      enabled: false,
      nextRunAt: null,
      lastError: "give up",
    });
  });

  it("a stored schedule with no next run disables the task on its first failure", async () => {
    const id = await newTask();
    await setRow(id, { schedule: { type: "interval", everyMs: 0 } });

    expect(await store.markFailed(id, "invalid everyMs", await claim(id))).toBe(true);

    expect(await store.getById(id)).toMatchObject({ consecutiveErrors: 1, enabled: false, nextRunAt: null });
  });

  it("failing a task that no longer exists writes nothing", async () => {
    expect(await store.markFailed("00000000-0000-0000-0000-000000000000", "ghost", null)).toBe(false);
  });

  it("recovery leaves the retry accounting and the next run untouched", async () => {
    const id = await newTask();
    await setRow(id, { consecutiveErrors: 2 });
    const before = await store.getById(id);
    await claim(id);

    expect(await store.clearRunningMarker([{ id, claim: await readClaim(id) }])).toEqual([id]);

    const row = await store.getById(id);
    expect(row).toMatchObject({ lastRunStatus: null, consecutiveErrors: 2, enabled: true });
    expect(row?.nextRunAt).toEqual(before?.nextRunAt);
  });

  it("recovery of nothing clears nothing", async () => {
    expect(await store.clearRunningMarker([])).toEqual([]);
  });

  it("lists an agent's tasks oldest first, a page at a time, and only the enabled ones when asked", async () => {
    const slug = asInstanceSlug(`itest-list-${Date.now()}`);
    const ids: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const task = await store.create({ instanceId: slug, name, prompt: "noop", schedule: { type: "interval", everyMs: 60_000 } });
      created.push(task.id);
      ids.push(task.id);
      await tick();
    }
    await store.disableTask(ids[1]!);

    expect((await store.listByInstance(slug)).map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect((await store.listByInstance(slug, { limit: 2 })).map((t) => t.name)).toEqual(["a", "b"]);
    expect((await store.listByInstance(slug, { limit: 2, offset: 2 })).map((t) => t.name)).toEqual(["c"]);
    expect((await store.listByInstance(slug, { offset: 1 })).map((t) => t.name)).toEqual(["b", "c"]);
    expect((await store.listByInstance(slug, { enabledOnly: true })).map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("caps an unbounded listing at the default page size", async () => {
    const slug = asInstanceSlug(`itest-cap-${Date.now()}`);
    const tasks = await Promise.all(
      Array.from({ length: store.LIST_BY_INSTANCE_DEFAULT_LIMIT + 1 }, (_, i) =>
        store.create({ instanceId: slug, name: `t${i}`, prompt: "noop", schedule: { type: "interval", everyMs: 60_000 } }),
      ),
    );
    created.push(...tasks.map((t) => t.id));

    expect(await store.listByInstance(slug)).toHaveLength(100);
  });
});
