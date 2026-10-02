// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The reaper's write against a real Postgres. The reaper reads the running rows,
 * judges one overdue, then marks it failed. Between the read and the write the
 * run it judged may have finished and the task been claimed again by another
 * replica; the `running` guard alone cannot tell the two claims apart, so the
 * reaper failed the NEW run and freed it for a third execution.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import * as store from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const created: string[] = [];

async function runningTask(): Promise<string> {
  const task = await store.create({
    instanceId: asInstanceSlug(`itest-reaper-${Date.now()}`),
    name: "reaper race",
    prompt: "noop",
    schedule: { type: "interval", everyMs: 60_000 },
  });
  created.push(task.id);
  expect(await store.markRunning(task.id)).toBe(true);
  return task.id;
}

async function readClaim(id: string): Promise<Date> {
  const row = (await store.findStuckRunning(new Date(Date.now() + 60_000))).find((t) => t.id === id);
  if (!row?.updatedAt) throw new Error("expected a running row");
  return row.updatedAt;
}

describe.skipIf(!DB_AVAILABLE)("scheduled task reaper write (integration)", () => {
  afterAll(async () => {
    for (const id of created) await store.remove(id).catch(() => {});
  });

  it("does not fail a claim made after the one it read", async () => {
    const id = await runningTask();
    const seen = await readClaim(id);

    // Meanwhile: the run finishes and another replica claims the task again.
    await store.markCompleted(id, "conversation-1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.markRunning(id)).toBe(true);

    expect(await store.markFailed(id, "orphaned", { runningSince: seen })).toBe(false);

    const row = await store.getById(id);
    expect(row?.lastRunStatus).toBe("running");
    expect(row?.consecutiveErrors).toBe(0);
  });

  it("fails the claim it read", async () => {
    const id = await runningTask();
    const seen = await readClaim(id);

    expect(await store.markFailed(id, "orphaned", { runningSince: seen })).toBe(true);

    const row = await store.getById(id);
    expect(row?.lastRunStatus).toBe("error");
    expect(row?.consecutiveErrors).toBe(1);
  });
});
