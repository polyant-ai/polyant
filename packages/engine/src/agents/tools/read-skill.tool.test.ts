// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The readSkill tool refuses a call without a name before any lookup. What it
 * reads for a named skill runs on Postgres in read-skill.tool.integration.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createMockAudit } from "../../test-utils.js";
import readSkillTool from "./read-skill.tool.js";

describe("readSkill tool", () => {
  it.each([{}, { name: null }, { name: "   " }])("refuses %j as a missing name", async (input) => {
    const result = await readSkillTool.execute(input as never, { instanceId: "my-instance", secrets: {}, audit: createMockAudit() } as never);

    expect(result).toEqual({ found: false, error: "Missing required parameter 'name'." });
  });
});
