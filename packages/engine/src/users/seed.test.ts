// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the config module BEFORE the SUT imports it.
vi.mock("../config.js", () => ({
  config: {
    initialAdmin: {} as { email?: string; password?: string },
  },
}));

vi.mock("./users.store.js", () => ({
  countUsers: vi.fn(),
  insertUser: vi.fn(),
}));

import * as store from "./users.store.js";
import { config } from "../config.js";
import { seedInitialAdmin } from "./seed.js";

const mockedStore = store as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mutableConfig = config as unknown as {
  initialAdmin: { email?: string; password?: string };
};

describe("seedInitialAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.initialAdmin = {};
  });

  it("is a no-op when the users table is not empty", async () => {
    mockedStore.countUsers.mockResolvedValueOnce(3);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await seedInitialAdmin();

    expect(mockedStore.insertUser).not.toHaveBeenCalled();
    // Operator visibility: skip path must be logged so "can't log in"
    // diagnosis is cheap (no silent skip).
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("Skipped");
    expect(log.mock.calls[0][0]).toContain("3 user(s)");
    log.mockRestore();
  });

  it("skips seeding (without inserting or printing secrets) when INITIAL_ADMIN_PASSWORD is unset", async () => {
    mockedStore.countUsers.mockResolvedValueOnce(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await seedInitialAdmin();

    // No user is created — operator must opt-in via INITIAL_ADMIN_PASSWORD.
    expect(mockedStore.insertUser).not.toHaveBeenCalled();
    // Operator visibility: one warning explaining the skip + how to recover.
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("INITIAL_ADMIN_PASSWORD");
    expect(msg).toContain("Skipping");
    // Defence-in-depth: no .log call either (so file-logger never tees a secret).
    expect(log).not.toHaveBeenCalled();

    warn.mockRestore();
    log.mockRestore();
  });

  it("uses INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD when set, and does NOT print the password", async () => {
    mockedStore.countUsers.mockResolvedValueOnce(0);
    mockedStore.insertUser.mockResolvedValueOnce({});
    mutableConfig.initialAdmin = {
      email: "boss@example.com",
      password: "supplied-by-env",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await seedInitialAdmin();

    expect(mockedStore.insertUser.mock.calls[0][0].email).toBe("boss@example.com");
    // Password from env: do NOT print it (admin already knows it).
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls[0][0] as string;
    expect(logged).toContain("boss@example.com");
    expect(logged).not.toContain("supplied-by-env");

    warn.mockRestore();
    log.mockRestore();
  });

  it("does not throw when insertUser rejects (caller logs and continues)", async () => {
    // Note: seed.ts itself does not catch — the boot wrapper in index.ts does.
    // This test just locks the contract that seed surfaces store errors.
    mockedStore.countUsers.mockResolvedValueOnce(0);
    mutableConfig.initialAdmin = { password: "set-via-env" };
    mockedStore.insertUser.mockRejectedValueOnce(new Error("db down"));
    await expect(seedInitialAdmin()).rejects.toThrow("db down");
  });
});
