// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The resolver and its cache. The cache is the part worth pinning: a policy an
 * administrator has just changed must take effect, and a policy read on every
 * activity-stream connect must not cost a query each time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn() }));

vi.mock("../database/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

vi.mock("../config.js", () => ({
  config: {
    analytics: { retentionDays: 90 },
    activityStream: { maxPerUser: 5 },
  },
}));

import {
  getStoredPlatformSettings,
  invalidatePlatformSettingsCache,
  resolvePlatformSettings,
  updatePlatformSettings,
} from "./platform-settings.store.js";

describe("platform settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidatePlatformSettingsCache();
  });

  it("should_fall_back_to_the_deployment_default_for_a_policy_the_installation_has_not_set", async () => {
    mockLimit.mockResolvedValue([{ analyticsRetentionDays: null, sseMaxConnectionsPerUser: null }]);

    expect(await resolvePlatformSettings()).toEqual({
      analyticsRetentionDays: 90,
      sseMaxConnectionsPerUser: 5,
    });
  });

  it("should_use_the_installations_own_policy_where_it_set_one", async () => {
    mockLimit.mockResolvedValue([{ analyticsRetentionDays: 30, sseMaxConnectionsPerUser: null }]);

    expect(await resolvePlatformSettings()).toEqual({
      analyticsRetentionDays: 30,
      sseMaxConnectionsPerUser: 5,
    });
  });

  it("should_keep_unset_visible_as_unset_for_the_page_that_edits_it", async () => {
    // `resolvePlatformSettings` answers what is in FORCE; this answers what is
    // STORED. Collapsing the two would make an empty field indistinguishable
    // from one set to the same number, and clearing it impossible to express.
    mockLimit.mockResolvedValue([{ analyticsRetentionDays: null, sseMaxConnectionsPerUser: 2 }]);

    expect(await getStoredPlatformSettings()).toEqual({
      analyticsRetentionDays: null,
      sseMaxConnectionsPerUser: 2,
    });
  });

  it("should_answer_the_deployment_default_when_the_row_is_missing", async () => {
    // The migration seeds the row, so an absent one means an unmigrated
    // database. Both policies read as unset, which is the behaviour every
    // installation had before this table existed.
    mockLimit.mockResolvedValue([]);

    expect(await resolvePlatformSettings()).toEqual({
      analyticsRetentionDays: 90,
      sseMaxConnectionsPerUser: 5,
    });
  });

  it("should_read_once_for_a_burst_of_callers", async () => {
    mockLimit.mockResolvedValue([{ analyticsRetentionDays: 30, sseMaxConnectionsPerUser: 2 }]);

    await Promise.all([resolvePlatformSettings(), resolvePlatformSettings()]);
    await resolvePlatformSettings();

    // The per-user cap is read on every connect; without the cache a burst of
    // subscribers would be a burst of queries.
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });

  it("should_show_a_change_immediately_rather_than_after_the_cache_expires", async () => {
    mockLimit.mockResolvedValue([{ analyticsRetentionDays: 90, sseMaxConnectionsPerUser: 5 }]);
    await resolvePlatformSettings();

    mockLimit.mockResolvedValue([{ analyticsRetentionDays: 7, sseMaxConnectionsPerUser: 5 }]);
    await updatePlatformSettings({ analyticsRetentionDays: 7 }, "user-1");

    // The write drops the cache: an administrator who shortens the retention
    // window must not be told it is still 90 while looking at the page.
    expect((await resolvePlatformSettings()).analyticsRetentionDays).toBe(7);
  });
});
