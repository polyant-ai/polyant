// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PATCH /api/platform/settings over REAL HTTP, for one reason: `@Body()` is
 * `undefined` — not `{}` — when a request carries no body AND no
 * `content-type`. That is an Express 5 change, and indexing the body then threw
 * a TypeError and answered 500 where the route's own next line answers 400.
 *
 * Only a real request can produce that value: a unit test calling the handler
 * supplies the body itself, which is the thing the framework was getting wrong.
 * Same root cause as the attachment wildcard — see
 * `server/attachments/attachments.controller.http.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { getStoredPlatformSettings, resolvePlatformSettings, updatePlatformSettings } = vi.hoisted(() => ({
  getStoredPlatformSettings: vi.fn(),
  resolvePlatformSettings: vi.fn(),
  updatePlatformSettings: vi.fn(),
}));

vi.mock("../../platform/platform-settings.store.js", () => ({
  getStoredPlatformSettings,
  resolvePlatformSettings,
  updatePlatformSettings,
}));
// The audit row is not the subject here and would need a database.
vi.mock("../../management-audit/management-audit-logger.js", () => ({
  createManagementAuditLogger: () => ({ log: vi.fn() }),
  ManagementAuditAction: { PlatformSettingsUpdate: "platform_settings.update" },
  ManagementAuditTarget: { PlatformSettings: "platform_settings" },
  toManagementAuditActor: () => undefined,
}));

import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PlatformSettingsController } from "./platform-settings.controller.js";

@Module({ controllers: [PlatformSettingsController] })
class TestModule {}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  getStoredPlatformSettings.mockResolvedValue({});
  resolvePlatformSettings.mockResolvedValue({});
  updatePlatformSettings.mockResolvedValue({});
});

describe("PATCH /api/platform/settings with no usable body", () => {
  it.each([
    ["no body and no content-type", { method: "PATCH" }],
    ["a json content-type and an empty body", { method: "PATCH", headers: { "content-type": "application/json" } }],
    ["an explicit empty object", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }],
  ])("answers 400, not 500, for %s", async (_label, init) => {
    const res = await fetch(`${baseUrl}/api/platform/settings`, init as RequestInit);

    expect(res.status).toBe(400);
    expect(updatePlatformSettings).not.toHaveBeenCalled();
  });

  it("still applies a real patch", async () => {
    const res = await fetch(`${baseUrl}/api/platform/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ analyticsRetentionDays: 30 }),
    });

    expect(res.status).toBe(200);
    expect(updatePlatformSettings).toHaveBeenCalledWith({ analyticsRetentionDays: 30 }, undefined);
  });
});
