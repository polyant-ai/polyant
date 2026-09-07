// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    auth: {} as { platformAdminEmail?: string },
    initialAdmin: {} as { email?: string; password?: string },
  },
}));

vi.mock("./organizations.store.js", () => ({
  findDefaultOrganization: vi.fn(),
  ensureConfiguredPlatformAdminOwner: vi.fn(),
  ensureExistingPlatformAdminOwner: vi.fn(),
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
const mutableConfig = config as unknown as {
  auth: { platformAdminEmail?: string };
  initialAdmin: { email?: string; password?: string };
};

describe("bootstrapOrganizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.auth = {};
    mutableConfig.initialAdmin = {};
    mockedStore.findDefaultOrganization.mockResolvedValue({ id: "org-1" });
    mockedUsers.countUsers.mockResolvedValue(0);
    mockedStore.ensureConfiguredPlatformAdminOwner.mockResolvedValue(null);
    mockedStore.ensureExistingPlatformAdminOwner.mockResolvedValue(null);
  });

  it("stops without touching tenancy when the default org is missing", async () => {
    mockedStore.findDefaultOrganization.mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.ensureConfiguredPlatformAdminOwner).not.toHaveBeenCalled();
    expect(mockedUsers.countUsers).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("Default organization not found");
    warn.mockRestore();
  });

  it("is a no-op on a fresh install (zero users)", async () => {
    mockedUsers.countUsers.mockResolvedValueOnce(0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.ensureConfiguredPlatformAdminOwner).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes("Fresh install"))).toBe(true);
    log.mockRestore();
  });

  it("makes the configured PLATFORM_ADMIN_EMAIL a default-org owner", async () => {
    mutableConfig.auth.platformAdminEmail = "boss@acme.com";
    mockedStore.ensureConfiguredPlatformAdminOwner.mockResolvedValueOnce("org-1");
    mockedUsers.countUsers.mockResolvedValueOnce(2);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.ensureConfiguredPlatformAdminOwner).toHaveBeenCalledWith("boss@acme.com");
  });

  it("does not log the configured email while awaiting first login", async () => {
    mutableConfig.auth.platformAdminEmail = "future@acme.com";
    mockedStore.ensureConfiguredPlatformAdminOwner.mockResolvedValueOnce(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(log.mock.calls.some((c) => String(c[0]).includes("future@acme.com"))).toBe(false);
    log.mockRestore();
  });

  it("makes the password-seeded platform admin an owner without elevating another user", async () => {
    mutableConfig.initialAdmin = {
      email: "administrator@local",
      password: "set-only-when-creating-the-initial-admin",
    };
    mockedStore.ensureExistingPlatformAdminOwner.mockResolvedValueOnce("org-1");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.ensureExistingPlatformAdminOwner).toHaveBeenCalledWith(
      "administrator@local",
    );
  });

  it("does not promote when PLATFORM_ADMIN_EMAIL is unset", async () => {
    mockedUsers.countUsers.mockResolvedValueOnce(5);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.ensureConfiguredPlatformAdminOwner).not.toHaveBeenCalled();
  });
});
