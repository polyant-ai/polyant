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
});
