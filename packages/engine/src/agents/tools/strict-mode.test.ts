// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { findIllegalToolName } from "./strict-mode-lint.js";

// The registry-wide sweeps live in registered-tools.guardrail.test.ts.
describe("findIllegalToolName", () => {
  it("accepts a flat name and a namespaced name (':' sanitizes to '__')", () => {
    expect(findIllegalToolName("webSearch")).toBeNull();
    expect(findIllegalToolName("acme:updateContactCrm")).toBeNull(); // → acme__updateContactCrm
    expect(findIllegalToolName("agent:my-slug")).toBeNull();
  });

  it("flags a canonical name outside the authoring grammar", () => {
    expect(findIllegalToolName("foo.bar")).toContain("not [a-zA-Z0-9_:-]+");
    expect(findIllegalToolName("ns:has space")).toContain("not [a-zA-Z0-9_:-]+");
  });
});
