// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * scheduleTask `update` never answers success for a schedule change it did not
 * make, against a real Postgres. Moving a reminder, a live model sent the new
 * `runAt` (with `timezone: "UTC"`) but no `scheduleType`; the update dropped the
 * time, answered success and kept the old one, because the schedule was rebuilt
 * only when `scheduleType` came too.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../../database/test-db.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import * as store from "../../scheduled-tasks/store.js";
import type { ScheduleConfig } from "../../scheduled-tasks/schema.js";
import { createMockAudit } from "../../test-utils.js";
import scheduleTaskTool from "./schedule-task.tool.js";
import { buildTool } from "./registry.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const created: string[] = [];
const AGENT = asInstanceSlug(`itest-update-${Date.now()}`);

/** Every parameter the tool's strict schema declares, null unless given. */
const NO_PARAMS = {
  name: null, prompt: null, scheduleType: null, cronExpression: null, timezone: null, everyMs: null, runAt: null,
  description: null, deleteAfterRun: null, outboundChannel: null, outboundTarget: null, keepHistory: null,
  taskId: null, enabled: null,
};

/** A task named "call the courier" with this schedule, removed after the suite. */
async function taskWith(schedule: ScheduleConfig) {
  const task = await store.create({ instanceId: AGENT, name: "call the courier", prompt: "call the courier", schedule });
  created.push(task.id);
  return task.id;
}

/** Call the tool's update as the agent's supervisor builds it. */
function update(params: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = buildTool(scheduleTaskTool, { instanceId: AGENT, audit: createMockAudit() } as any) as any;
  return tool.execute({ ...NO_PARAMS, action: "update", ...params }, { toolCallId: "tc-1", messages: [] });
}

const stored = async (id: string) => {
  const row = await store.getById(id);
  return { name: row?.name, schedule: row?.schedule };
};

describe.skipIf(!DB_AVAILABLE)("scheduleTask update and its schedule fields (integration)", () => {
  afterAll(async () => {
    for (const id of created) await store.remove(id).catch(() => {});
  });

  it("does not answer success while keeping the old time when runAt comes without scheduleType", async () => {
    const id = await taskWith({ type: "one-shot", runAt: "2099-01-01T09:00:00.000Z" });

    // The call shape a live model sent.
    const result = await update({ taskId: id, runAt: "2099-01-01T10:00:00Z", timezone: "UTC" });

    expect(result).toMatchObject({ error: expect.stringContaining("scheduleType") });
    expect(await stored(id)).toEqual({
      name: "call the courier",
      schedule: { type: "one-shot", runAt: "2099-01-01T09:00:00.000Z" },
    });
  });

  it("does not answer success while keeping the old cron when cronExpression comes without scheduleType", async () => {
    const id = await taskWith({ type: "cron", expression: "0 9 * * *", timezone: "Europe/Rome" });

    expect(await update({ taskId: id, cronExpression: "0 10 * * *" })).toMatchObject({
      error: expect.stringContaining("scheduleType"),
    });
    expect((await stored(id)).schedule).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "Europe/Rome" });
  });

  it("does not answer success while keeping the old interval when everyMs comes without scheduleType", async () => {
    const id = await taskWith({ type: "interval", everyMs: 3_600_000 });

    expect(await update({ taskId: id, everyMs: 7_200_000 })).toMatchObject({
      error: expect.stringContaining("scheduleType"),
    });
    expect((await stored(id)).schedule).toEqual({ type: "interval", everyMs: 3_600_000 });
  });

  it("applies nothing from a refused call, so the model is told the whole call failed", async () => {
    const id = await taskWith({ type: "one-shot", runAt: "2099-01-01T09:00:00.000Z" });

    expect(await update({ taskId: id, name: "call the carrier", runAt: "2099-01-01T10:00:00Z" })).toMatchObject({
      error: expect.stringContaining("Nothing was changed"),
    });
    expect((await stored(id)).name).toBe("call the courier");
  });

  it("still renames a task when the model echoes the default timezone", async () => {
    const id = await taskWith({ type: "cron", expression: "0 9 * * *", timezone: "Europe/Rome" });

    expect(await update({ taskId: id, name: "call the carrier", timezone: "UTC" })).toMatchObject({ success: true });
    expect(await stored(id)).toEqual({
      name: "call the carrier",
      schedule: { type: "cron", expression: "0 9 * * *", timezone: "Europe/Rome" },
    });
  });

  it("moves the task once scheduleType comes with the new time", async () => {
    const id = await taskWith({ type: "one-shot", runAt: "2099-01-01T09:00:00.000Z" });

    const result = await update({ taskId: id, scheduleType: "one-shot", runAt: "2099-01-01T10:00:00.000Z", timezone: "UTC" });

    expect(result).toMatchObject({ success: true, task: { nextRunAt: "2099-01-01T10:00:00.000Z" } });
    expect((await stored(id)).schedule).toEqual({ type: "one-shot", runAt: "2099-01-01T10:00:00.000Z" });
  });

  it("still asks for the field a scheduleType needs", async () => {
    const id = await taskWith({ type: "one-shot", runAt: "2099-01-01T09:00:00.000Z" });

    expect(await update({ taskId: id, scheduleType: "interval" })).toMatchObject({ error: expect.stringContaining("everyMs") });
    expect((await stored(id)).schedule).toEqual({ type: "one-shot", runAt: "2099-01-01T09:00:00.000Z" });
  });
});
