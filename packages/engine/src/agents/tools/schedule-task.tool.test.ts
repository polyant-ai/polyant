import { describe, expect, it, vi } from "vitest";

vi.mock("../../scheduled-tasks/store.js", () => ({}));
vi.mock("../../scheduled-tasks/scheduler.service.js", () => ({ schedulerService: {} }));

const { buildScheduleConfig } = await import("./schedule-task.tool.js");

describe("buildScheduleConfig", () => {
  it("stores UTC when a cron names no timezone", () => {
    expect(buildScheduleConfig({ scheduleType: "cron", cronExpression: "0 9 * * 1-5", timezone: null })).toEqual({
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: "UTC",
    });
  });

  it("keeps the timezone the model names", () => {
    expect(
      buildScheduleConfig({ scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "Europe/Rome" }),
    ).toMatchObject({ timezone: "Europe/Rome" });
  });

  it.each([0, -5, 59_999, 1.5])("refuses an interval of %s ms", (everyMs) => {
    expect(buildScheduleConfig({ scheduleType: "interval", everyMs })).toEqual({
      error: "Field 'everyMs' must be an integer of at least 60000 ms.",
    });
  });

  it("builds a one-minute interval", () => {
    expect(buildScheduleConfig({ scheduleType: "interval", everyMs: 60_000 })).toEqual({ type: "interval", everyMs: 60_000 });
  });
});
