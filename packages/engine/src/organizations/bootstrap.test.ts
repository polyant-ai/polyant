// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    auth: {} as { platformAdminEmail?: string },
  },
}));

vi.mock("./organizations.store.js", () => ({
  findDefaultOrganization: vi.fn(),
  promotePlatformAdminByEmail: vi.fn(),
}));

vi.mock("../users/users.store.js", () => ({
  countUsers: vi.fn(),
}));

import * as store from "./organizations.store.js";
import * as usersStore from "../users/users.store.js";
import { config } from "../config.js";
import { bootstrapOrganizations } from "./bootstrap.js";

const mockedStore = store as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockedUsers = usersStore as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mutableConfig = config as unknown as { auth: { platformAdminEmail?: string } };

describe("bootstrapOrganizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.auth = {};
    mockedStore.findDefaultOrganization.mockResolvedValue({ id: "org-1" });
    mockedUsers.countUsers.mockResolvedValue(0);
    mockedStore.promotePlatformAdminByEmail.mockResolvedValue(0);
  });

  it("stops without touching tenancy when the default org is missing", async () => {
    mockedStore.findDefaultOrganization.mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.promotePlatformAdminByEmail).not.toHaveBeenCalled();
    expect(mockedUsers.countUsers).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("Default organization not found");
    warn.mockRestore();
  });

  it("is a no-op on a fresh install (zero users)", async () => {
    mockedUsers.countUsers.mockResolvedValueOnce(0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.promotePlatformAdminByEmail).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes("Fresh install"))).toBe(true);
    log.mockRestore();
  });

  it("promotes the configured PLATFORM_ADMIN_EMAIL (idempotent UPDATE)", async () => {
    mutableConfig.auth.platformAdminEmail = "boss@acme.com";
    mockedStore.promotePlatformAdminByEmail.mockResolvedValueOnce(1);
    mockedUsers.countUsers.mockResolvedValueOnce(2);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.promotePlatformAdminByEmail).toHaveBeenCalledWith("boss@acme.com");
  });

  it("logs a deferral when PLATFORM_ADMIN_EMAIL has no matching user yet", async () => {
    mutableConfig.auth.platformAdminEmail = "future@acme.com";
    mockedStore.promotePlatformAdminByEmail.mockResolvedValueOnce(0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(log.mock.calls.some((c) => String(c[0]).includes("will apply once they sign in"))).toBe(true);
    log.mockRestore();
  });

  it("does not promote when PLATFORM_ADMIN_EMAIL is unset", async () => {
    mockedUsers.countUsers.mockResolvedValueOnce(5);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.promotePlatformAdminByEmail).not.toHaveBeenCalled();
  });
});
