// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The role vocabulary and its one-release read tolerance.
 *
 * This file exists because the failure mode of getting the rename wrong is
 * SILENT: a platform admin whose role no longer matches is not refused with an
 * error, they are quietly served as an ordinary user. Nothing else in the suite
 * would notice.
 */

import { describe, it, expect } from "vitest";
import {
  LEGACY_PLATFORM_ADMIN_ROLE,
  PLATFORM_ADMIN_ROLE,
  PLATFORM_ADMIN_ROLE_VALUES,
  isPlatformAdminRole,
  normalizeUserRole,
} from "./user-role.js";

describe("the canonical role value", () => {
  it("should_be_platform_admin_matching_the_is_platform_admin_column", () => {
    // Pinned as a literal on purpose: this is a PERSISTED value and a wire value.
    // Changing it is a migration, not a refactor, so it must not be possible to
    // change it and keep the suite green.
    expect(PLATFORM_ADMIN_ROLE).toBe("platform_admin");
  });

  it("should_keep_superadmin_as_the_legacy_value_only", () => {
    expect(LEGACY_PLATFORM_ADMIN_ROLE).toBe("superadmin");
    expect(PLATFORM_ADMIN_ROLE_VALUES).toEqual(["platform_admin", "superadmin"]);
  });
});

describe("isPlatformAdminRole", () => {
  it("should_accept_the_canonical_value", () => {
    expect(isPlatformAdminRole("platform_admin")).toBe(true);
  });

  it("should_accept_the_legacy_value_so_a_pre_rename_row_or_token_keeps_its_powers", () => {
    expect(isPlatformAdminRole("superadmin")).toBe(true);
  });

  it("should_refuse_everything_else_including_absent_and_lookalike_values", () => {
    for (const value of [
      "user",
      "owner",
      "admin",
      "platformadmin",
      "platform-admin",
      "PLATFORM_ADMIN",
      "Superadmin",
      "",
      null,
      undefined,
    ]) {
      expect(isPlatformAdminRole(value)).toBe(false);
    }
  });
});

describe("normalizeUserRole", () => {
  it("should_fold_both_spellings_onto_the_canonical_value", () => {
    expect(normalizeUserRole("platform_admin")).toBe("platform_admin");
    expect(normalizeUserRole("superadmin")).toBe("platform_admin");
  });

  it("should_fail_closed_to_user_for_anything_unrecognised", () => {
    // A malformed, absent or hostile claim must never resolve to platform admin.
    for (const value of [
      "user",
      "owner",
      "",
      null,
      undefined,
      42,
      true,
      {},
      ["platform_admin"],
    ]) {
      expect(normalizeUserRole(value)).toBe("user");
    }
  });
});
