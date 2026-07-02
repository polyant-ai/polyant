// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, beforeAll } from "vitest";
import { loadAllTools, getToolRegistry } from "./registry.js";
import { findStrictModeViolations } from "./strict-mode-lint.js";

// Guard-rail: every registered tool must produce a JSON schema compatible
// with OpenAI strict-mode (Responses API /v1/responses).
// Past violations: .url() in http-request, .optional() in hubspot-contact.
// See CLAUDE.md → Important Caveats.
//
// Known limit: synthetic `ask_{slug}` tools for agent-to-agent (see
// channels/adapters/agent.adapter.ts) are built dynamically in
// supervisor/index.ts and NOT in the static registry, so they are not covered
// here. Their schema is trivial ({ prompt: string }) and conforms.

describe("Tool schemas — OpenAI strict-mode compatibility", () => {
  beforeAll(async () => {
    await loadAllTools();
  });

  // SKIP: when AUTH_SECRET was added to test-setup (so activity-stream emit-helpers
  // could load config in tests), this guard-rail started exercising tools that had
  // never been audited end-to-end and surfaced ~12 pre-existing strict-mode
  // violations (writeFile.overwrite, scheduleTask.*, ghPR.*, ghIssue.*, etc. —
  // tools using `.optional()` without making the field nullable in the schema).
  // These are real bugs in the tool definitions, NOT in this guard-rail. They
  // are out of scope for the activity-stream wire-up commit; re-enable once the
  // tool schemas are fixed in a dedicated follow-up.
  it("every registered tool produces a strict-mode-valid JSON schema", () => {
    const violations: string[] = [];
    let checked = 0;
    let skipped = 0;

    for (const [name, def] of getToolRegistry()) {
      if (def.metaTool) {
        // Meta-tools (e.g. spawnTask) are built specially by the supervisor
        // (createTaskTool); their catalog schema is not equipped via buildTool.
        skipped++;
        continue;
      }
      // Every tool is serialized — it already carries the JSON Schema (converted
      // from Zod at defineTool time, in the tool's own realm).
      violations.push(...findStrictModeViolations(def.inputSchema, name));
      checked++;
    }

    expect(checked, "no tools were checked — registry empty?").toBeGreaterThan(0);
    expect(
      violations,
      `\n${violations.length} strict-mode violation(s) across ${checked} tool(s) (${skipped} meta-tool(s) skipped):\n  - ${violations.join("\n  - ")}\n`,
    ).toEqual([]);
  });
});
