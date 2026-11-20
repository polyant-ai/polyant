// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { SYSTEM_ROLE_KEYS, SYSTEM_ROLE_PERMISSIONS, roleLevel } from "./permissions.js";

/*
  The role hierarchy is enforced by LEVEL (RoleBindingService lets an actor
  grant any role at or below its own level) while what a role can do is its
  PERMISSION LIST. The two are written separately, so nothing but this check
  keeps them agreeing: a higher level must hold every permission of a lower
  one, or "may grant a role at or below mine" hands out permissions the granter
  does not have.

  The domain is every ordered pair of system roles from the catalogue. It is
  small enough to check exhaustively, which is stronger than sampling it.
*/
describe("system role hierarchy (property)", () => {
  it("a role at a higher or equal level holds every permission of a lower one", () => {
    const pairs = SYSTEM_ROLE_KEYS.flatMap((a) => SYSTEM_ROLE_KEYS.map((b) => [a, b] as const)).filter(
      ([a, b]) => roleLevel(a) >= roleLevel(b),
    );
    // Vacuity guard: at least the strict chain plus every role with itself.
    expect(pairs.length).toBeGreaterThanOrEqual(SYSTEM_ROLE_KEYS.length * 2 - 1);
    for (const [a, b] of pairs) {
      const higher = new Set(SYSTEM_ROLE_PERMISSIONS[a]);
      const missing = SYSTEM_ROLE_PERMISSIONS[b].filter((p) => !higher.has(p));
      expect(missing, `${a} (level ${roleLevel(a)}) lacks permissions of ${b}`).toEqual([]);
    }
  });
});
