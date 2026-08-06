// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single role comparison behind every client-side platform-admin gate.
 *
 * What is worth pinning is the READ TOLERANCE: the platform-admin role was
 * renamed `superadmin` → `platform_admin`, and a 30-day Auth.js JWT with no
 * revocation keeps delivering the old spelling for up to a month. Accepting only
 * the canonical literal would hide every platform-admin section from someone who
 * still holds every one of those powers — a failure that looks identical to
 * "nobody is an admin any more".
 *
 * The mirror of these semantics lives in packages/engine/src/auth/user-role.ts;
 * the two packages share no code, so the behaviour is asserted on both sides.
 * Note the fold is EXACT-MATCH on purpose — no trimming, no case folding — so a
 * mangled claim fails closed rather than being guessed at.
 */

import { describe, it, expect } from "vitest";
import {
  isPlatformAdminRole,
  normalizeUserRole,
  LEGACY_PLATFORM_ADMIN_ROLE,
  PLATFORM_ADMIN_ROLE,
} from "./user-role";

describe("role vocabulary", () => {
  it("names the canonical value and keeps the legacy one distinct", () => {
    expect(PLATFORM_ADMIN_ROLE).toBe("platform_admin");
    expect(LEGACY_PLATFORM_ADMIN_ROLE).toBe("superadmin");
  });
});

describe("isPlatformAdminRole", () => {
  it("accepts BOTH spellings of the platform-admin role", () => {
    expect(isPlatformAdminRole(PLATFORM_ADMIN_ROLE)).toBe(true);
    expect(isPlatformAdminRole(LEGACY_PLATFORM_ADMIN_ROLE)).toBe(true);
  });

  it("rejects a plain user", () => {
    expect(isPlatformAdminRole("user")).toBe(false);
  });

  it("rejects an absent role", () => {
    expect(isPlatformAdminRole(null)).toBe(false);
    expect(isPlatformAdminRole(undefined)).toBe(false);
    expect(isPlatformAdminRole("")).toBe(false);
  });

  // Fail closed: the comparison is exact, so a claim that merely LOOKS like the
  // role is not one. Were this ever relaxed, it should be relaxed deliberately.
  it.each([
    "Platform_Admin",
    "PLATFORM_ADMIN",
    " platform_admin",
    "platform_admin ",
    "SuperAdmin",
    "platform_admin_readonly",
    "not_platform_admin",
  ])("rejects the look-alike %s", (value) => {
    expect(isPlatformAdminRole(value)).toBe(false);
  });
});

describe("normalizeUserRole", () => {
  it("folds both spellings onto the canonical value", () => {
    expect(normalizeUserRole(PLATFORM_ADMIN_ROLE)).toBe(PLATFORM_ADMIN_ROLE);
    expect(normalizeUserRole(LEGACY_PLATFORM_ADMIN_ROLE)).toBe(PLATFORM_ADMIN_ROLE);
  });

  it("maps a plain user to itself", () => {
    expect(normalizeUserRole("user")).toBe("user");
  });

  // The input is `unknown` because it comes off a JWT claim / API payload: every
  // shape that is not an accepted role string is a plain `user`.
  it.each([null, undefined, "", "editor", 42, true, {}, [], () => {}])(
    "falls back to user for %o",
    (value) => {
      expect(normalizeUserRole(value)).toBe("user");
    },
  );
});
