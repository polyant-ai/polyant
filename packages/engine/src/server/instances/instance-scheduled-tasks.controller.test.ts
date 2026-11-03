// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";

const { mockCreate, mockUpdate, mockGetById } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetById: vi.fn(),
}));

vi.mock("../../scheduled-tasks/store.js", () => ({ create: mockCreate, update: mockUpdate, getById: mockGetById }));
vi.mock("../../scheduled-tasks/run-log.store.js", () => ({}));
vi.mock("../../scheduled-tasks/scheduler.service.js", () => ({ schedulerService: {} }));
vi.mock("./instance-helpers.js", () => ({
  findInstanceOrFail: vi.fn().mockResolvedValue({ id: "uuid-1", slug: "acme" }),
}));

import { InstanceScheduledTasksController } from "./instance-scheduled-tasks.controller.js";

const controller = new InstanceScheduledTasksController();
const savedTask = {
  id: "task-1",
  name: "digest",
  instanceId: "acme",
  schedule: { type: "interval", everyMs: 3_600_000 },
  enabled: true,
  keepHistory: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(savedTask);
  mockUpdate.mockResolvedValue(savedTask);
  mockGetById.mockResolvedValue(savedTask);
});

describe("scheduled task schedules from the API", () => {
  it.each([0, -5, 59_999, 1.5])("refuses to create an interval of %s ms and stores nothing", async (everyMs) => {
    await expect(
      controller.create("acme", { name: "digest", prompt: "go", schedule: { type: "interval", everyMs } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([0, -5])("refuses to change a schedule to an interval of %s ms", async (everyMs) => {
    await expect(
      controller.update("acme", "task-1", { schedule: { type: "interval", everyMs } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("names the field at fault", async () => {
    await expect(
      controller.create("acme", { name: "digest", prompt: "go", schedule: { type: "interval", everyMs: 0 } }),
    ).rejects.toThrow("schedule.everyMs");
  });

  it("stores a valid interval with only the fields of its type", async () => {
    const schedule = { type: "interval", everyMs: 3_600_000, note: "dropped" } as never;
    await controller.create("acme", { name: "digest", prompt: "go", schedule });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: { type: "interval", everyMs: 3_600_000 } }),
    );
  });

  it("leaves the schedule alone when an update does not send one", async () => {
    await controller.update("acme", "task-1", { name: "renamed" });
    expect(mockUpdate).toHaveBeenCalledWith("task-1", expect.objectContaining({ name: "renamed", schedule: undefined }));
  });
});
