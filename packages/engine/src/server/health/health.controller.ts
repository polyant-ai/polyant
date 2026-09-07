// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../../auth/decorators/public.decorator.js";
import { schedulerService } from "../../scheduled-tasks/scheduler.service.js";

@SkipThrottle()
@Public()
@Controller("health")
export class HealthController {
  @Get()
  check() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "polyant",
    };
  }

  /**
   * Scheduler liveness, in numbers rather than in a status word.
   *
   * The scheduled-task loop fails by going SILENT: nothing throws, every task stays
   * `enabled`, and `/health` keeps answering `ok` while no task runs. Two counts make
   * that observable from outside the process:
   *
   *   freeSlots     — concurrency slots not held by a run. Zero across consecutive
   *                   scrapes means the loop is wedged: `MAX_CONCURRENT` is process-wide,
   *                   so runs that never finish stop the tasks of EVERY instance.
   *   stuckRunning  — rows marked `running` for longer than the default run deadline,
   *                   i.e. runs the reaper is about to fail or cannot see. Non-zero for
   *                   more than a tick or two is the signature of the crash-safety bug
   *                   this endpoint exists to expose.
   *
   * Counts only — no instance names, no task names, nothing an unauthenticated caller
   * could use to enumerate tenants.
   */
  @Get("scheduler")
  async scheduler() {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      scheduler: await schedulerService.health(),
    };
  }
}
