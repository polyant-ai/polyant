// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Guard-rail: a tool must be REACHABLE by an agent that configured it.
 *
 * `missingRequiredSecrets` decides whether the supervisor offers a tool to the
 * model at all, and a tool it hides produces no error anywhere — it is simply
 * never called. The failure is therefore invisible from the outside: the agent
 * behaves as if the tool did not exist, which is indistinguishable from the
 * model choosing not to use it.
 *
 * That happened to a core tool once (oss#350): its `requiredSecrets` listed
 * two alternative credential shapes as bare strings, and a bare string
 * normalizes to a MANDATORY spec. No agent could hold both shapes at once, so
 * the mandatory set was unsatisfiable and the tool disappeared.
 *
 * The sweep below exercises the gate itself and would catch it being read the
 * wrong way round. It does NOT catch an unsatisfiable mandatory set, because
 * "the keys a tool declares mandatory" is exactly what it sets; a tool whose
 * credentials come in alternative shapes needs its own test naming each shape.
 */

import { describe, expect, it, beforeAll } from "vitest";
import {
  loadAllTools,
  getToolRegistry,
  missingRequiredSecrets,
  normalizeRequiredSecrets,
} from "./registry.js";

describe("requiredSecrets gate availability", () => {
  beforeAll(async () => {
    await loadAllTools();
  });

  /**
   * The gate itself, exercised over every registered tool: setting exactly the
   * keys a tool declares MANDATORY must make it available. This is what breaks
   * if the optional flag is ever read the wrong way round — an inverted filter
   * passes every unit test of `normalizeRequiredSecrets` and hides every tool
   * that declares an optional key.
   */
  it("offers every tool once its mandatory keys are set", () => {
    let checked = 0;
    const hidden: string[] = [];

    for (const [name, def] of getToolRegistry()) {
      if (!def.requiredSecrets?.length) continue;
      checked += 1;
      const mandatory = normalizeRequiredSecrets(def.requiredSecrets).filter((s) => !s.optional);
      const secrets = Object.fromEntries(mandatory.map((s) => [s.key, "set"]));
      if (missingRequiredSecrets(def.requiredSecrets, secrets).length > 0) hidden.push(name);
    }

    // A canary against an empty registry, not a census: the count dropped sharply
    // when the HubSpot and PDF families moved into plugins, and it will keep
    // drifting. Anything above zero means the loader ran.
    expect(checked, "no tool declares requiredSecrets — registry empty?").toBeGreaterThan(0);
    expect(hidden).toEqual([]);
  });
});
