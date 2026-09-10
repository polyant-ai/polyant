// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    initialAdmin: {} as { email?: string; password?: string },
  },
}));

vi.mock("./organizations.store.js", () => ({
  findDefaultOrganization: vi.fn(),
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
  initialAdmin: { email?: string; password?: string };
};

describe("bootstrapOrganizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.initialAdmin = {};
    mockedStore.findDefaultOrganization.mockResolvedValue({ id: "org-1" });
    mockedUsers.countUsers.mockResolvedValue(0);
    mockedStore.ensureExistingPlatformAdminOwner.mockResolvedValue(null);
  });

  it("stops without touching tenancy when the default org is missing", async () => {
    mockedStore.findDefaultOrganization.mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.ensureExistingPlatformAdminOwner).not.toHaveBeenCalled();
    expect(mockedUsers.countUsers).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("Default organization not found");
    warn.mockRestore();
  });

  it("is a no-op on a fresh install (zero users)", async () => {
    mockedUsers.countUsers.mockResolvedValueOnce(0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.ensureExistingPlatformAdminOwner).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes("Fresh install"))).toBe(true);
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

  it("touches nothing when no initial admin password was configured", async () => {
    // The seed password is what identifies a deployment that deliberately
    // created the local account. Without it there is no bootstrap identity to
    // complete, and nothing here may pick one by matching an address.
    mockedUsers.countUsers.mockResolvedValueOnce(5);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await bootstrapOrganizations();

    expect(mockedStore.ensureExistingPlatformAdminOwner).not.toHaveBeenCalled();
  });
});
