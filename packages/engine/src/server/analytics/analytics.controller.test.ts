// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { PATH_METADATA } from "@nestjs/common/constants.js";
import { AnalyticsController } from "./analytics.controller.js";

/**
 * Route-path lock for the analytics controller.
 *
 * Regression guard: during the instance→agent rename the per-agent handler's
 * `@Get` decorator was left as `instances/:slug/analytics` while the web client
 * moved to `/api/agents/:slug/analytics` (and the `/api/instances` rewrite +
 * alias were removed), silently 404-ing the per-agent analytics tab. These
 * assertions pin the canonical paths so a future rename can't reintroduce it.
 */
describe("AnalyticsController route paths", () => {
  const readPath = (target: object): string =>
    Reflect.getMetadata(PATH_METADATA, target) as string;

  const prototype = AnalyticsController.prototype as unknown as Record<
    string,
    unknown
  >;

  it("serves the global dashboard on api/analytics", () => {
    expect(readPath(AnalyticsController)).toBe("api");
    expect(readPath(prototype.global as object)).toBe("analytics");
  });

  it("serves per-agent analytics on the canonical agents/:slug path", () => {
    const path = readPath(prototype.perInstance as object);
    expect(path).toBe("agents/:slug/analytics");
    expect(path).not.toContain("instances/");
  });
});
