// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { health } = vi.hoisted(() => ({ health: vi.fn() }));
vi.mock("../../scheduled-tasks/scheduler.service.js", () => ({ schedulerService: { health } }));

import { HealthController, SCHEDULER_HEALTH_TTL_MS } from "./health.controller.js";

describe("GET /health/scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    health.mockReset().mockResolvedValue({ running: true, freeSlots: 3 });
  });
  afterEach(() => vi.useRealTimers());

  it("answers a burst of anonymous requests with one database reading", async () => {
    const controller = new HealthController();

    await Promise.all(Array.from({ length: 20 }, () => controller.scheduler()));

    expect(health).toHaveBeenCalledTimes(1);
  });

  it("reads again once the reading is older than its window", async () => {
    const controller = new HealthController();
    await controller.scheduler();

    vi.advanceTimersByTime(SCHEDULER_HEALTH_TTL_MS);
    const second = await controller.scheduler();

    expect(health).toHaveBeenCalledTimes(2);
    expect(second.scheduler).toEqual({ running: true, freeSlots: 3 });
  });

  it("does not keep serving a failed reading", async () => {
    const controller = new HealthController();
    health.mockRejectedValueOnce(new Error("db down"));
    await expect(controller.scheduler()).rejects.toThrow("db down");

    await controller.scheduler();

    expect(health).toHaveBeenCalledTimes(2);
  });
});
