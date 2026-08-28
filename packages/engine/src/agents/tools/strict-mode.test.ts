// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, beforeAll } from "vitest";
import { loadAllTools, getToolRegistry } from "./registry.js";
import { findStrictModeViolations, findIllegalToolName } from "./strict-mode-lint.js";

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

  // HISTORY: this guard-rail was briefly disabled after AUTH_SECRET landed in
  // test-setup, because it then reached tools that had never been audited and
  // surfaced ~12 pre-existing violations (writeFile.overwrite, scheduleTask.*,
  // ghPR.*, ghIssue.* — `.optional()` without a nullable field). Those schemas
  // were fixed and the guard has been LIVE and green ever since.
  //
  // The note is kept only because the word SKIP sat here long after the skip
  // did, telling every reader the guard was off and twelve violations were
  // outstanding — which is an invitation to add a `.skip` to match the comment
  // the next time an unrelated change makes this red. If it goes red, a tool
  // schema is wrong: fix the schema.
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

  it("every registered tool name is provider-legal after ':' sanitization", () => {
    const bad = [...getToolRegistry().keys()].map(findIllegalToolName).filter(Boolean);
    expect(bad, `\n${bad.join("\n")}\n`).toEqual([]);
  });
});

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
