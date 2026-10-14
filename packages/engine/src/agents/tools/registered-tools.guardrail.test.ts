// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Guard-rails over the loaded tool registry.
 *
 * Loading every core tool costs seconds of imports, and three files used to pay
 * it separately for one assertion each. They share one load here; each describe
 * keeps the reasoning it was written with.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadAllTools, getToolRegistry, missingRequiredSecrets, normalizeRequiredSecrets } from "./registry.js";
import { findStrictModeViolations, findIllegalToolName } from "./strict-mode-lint.js";

beforeAll(async () => {
  await loadAllTools();
});

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

/** Every non-test module in this directory that default-exports something —
 *  the shape of a tool module, whatever the file is called. */
function toolModuleFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => /\.(ts|js)$/.test(f) && !/\.(test|spec)\.(ts|js)$/.test(f))
    .filter((f) => /^export default /m.test(readFileSync(join(TOOLS_DIR, f), "utf-8")))
    .sort();
}

/**
 * Guard-rail: a tool file that the loader does not pick up must fail a test,
 * not disappear.
 *
 * `importRoot` globs for `*.tool.(ts|js)`. A tool file whose name misses that
 * pattern is never imported, so it is never registered, so `syncToolsToDb`
 * never writes its catalog row — and without a catalog row the tool cannot be
 * enabled on any agent, cannot appear in the panel, and cannot be named in
 * `PATCH /api/instances/:slug/tools`. Nothing reports any of this: there is no
 * error, no warning (the warn only fires for a file that DID match the glob and
 * had no default export), and no failing test.
 *
 * That is how `spawnTask` was unreachable from the first commit (oss#377): its
 * file was `task-tool.ts`, a hyphen where the glob wants a dot. Every consumer
 * downstream was correctly wired for it — `buildTools` skips meta-tools so the
 * supervisor can build the real one, the catalog carries an `is_meta` column,
 * the strict-mode sweep skips meta-tools — all of it waiting on a registry
 * entry that was never created.
 *
 * Discovery is by `export default`, not by filename, because the filename is
 * precisely what the bug gets wrong: asking the filesystem the same question
 * the loader asks would reproduce the blind spot instead of catching it.
 */
describe("core tool discovery", () => {
  it("registers every tool module in the core tools directory", async () => {
    const files = toolModuleFiles();
    expect(files.length, "no tool modules discovered — is the directory scan still right?").toBeGreaterThan(0);

    const registered = new Set(getToolRegistry().keys());
    const unreachable: string[] = [];

    for (const file of files) {
      const mod = (await import(join(TOOLS_DIR, file))) as { default?: { name?: string } };
      const name = mod.default?.name;
      if (!name) continue; // default export that is not a tool definition
      if (!registered.has(name)) {
        unreachable.push(`${file} defines "${name}", which the loader never registered`);
      }
    }

    expect(
      unreachable,
      `\n${unreachable.length} tool(s) unreachable — the file name must match the loader's *.tool.(ts|js) glob:\n  - ${unreachable.join("\n  - ")}\n`,
    ).toEqual([]);
  });
});

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
describe("requiredSecrets gate availability", () => {
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

/**
 * Guard-rail: every core tool a person can see in the panel is described for
 * them in English and Italian. The panel falls back to the first line of the
 * model-facing description, which is English text written as instructions;
 * without this sweep a new tool would quietly show that to an Italian reader.
 * Harness and meta-tools are hidden from the panel, so they are exempt.
 */
describe("core tools are described for people", () => {
  it("gives every visible core tool a summary and every field a label, in en-US and it-IT", () => {
    const gaps: string[] = [];
    const bilingual = (text: unknown) =>
      typeof text === "object" && text !== null && "en-US" in text && "it-IT" in text;
    for (const def of getToolRegistry().values()) {
      if (def.name.includes(":") || def.harness || def.metaTool) continue;
      if (!bilingual(def.summary)) gaps.push(`${def.name}: summary`);
      for (const spec of normalizeRequiredSecrets(def.requiredSecrets, def.name)) {
        if (!bilingual(spec.label)) gaps.push(`${def.name}: ${spec.key} label`);
        if (spec.description !== undefined && !bilingual(spec.description)) gaps.push(`${def.name}: ${spec.key} description`);
      }
    }
    expect(gaps).toEqual([]);
  });
});
