// SPDX-License-Identifier: AGPL-3.0-or-later

// Every coding agent reads the same instructions and skills: CLAUDE.md imports
// AGENTS.md, and `.agents/skills/` links each canonical skill in
// `.claude/skills/` for agents that discover skills there.

import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const canonicalDir = path.join(root, ".claude/skills");
const linkDir = path.join(root, ".agents/skills");

const canonical = readdirSync(canonicalDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test("CLAUDE.md imports AGENTS.md", () => {
  const lines = readFileSync(path.join(root, "CLAUDE.md"), "utf8").split(/\r?\n/);
  assert.ok(lines.includes("@AGENTS.md"), "CLAUDE.md needs a line containing only `@AGENTS.md`.");
});

test(".agents/skills links every canonical skill and nothing else", () => {
  assert.ok(canonical.length > 0, "no skill directories found in .claude/skills");
  const linked = readdirSync(linkDir).sort();
  const missing = canonical.filter((name) => !linked.includes(name));
  const extra = linked.filter((name) => !canonical.includes(name));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    "Add each missing skill with `ln -s ../../.claude/skills/<name> .agents/skills/<name>` " +
      "and remove entries whose skill no longer exists.",
  );
});

for (const name of canonical) {
  test(`skill ${name} is linked and declares its frontmatter`, () => {
    const link = path.join(linkDir, name);
    assert.ok(
      lstatSync(link).isSymbolicLink(),
      `.agents/skills/${name} must be a link: \`ln -s ../../.claude/skills/${name} .agents/skills/${name}\``,
    );
    assert.equal(realpathSync(link), realpathSync(path.join(canonicalDir, name)));

    const text = readFileSync(path.join(canonicalDir, name, "SKILL.md"), "utf8");
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    assert.match(frontmatter, /^name: \S/m, `${name}/SKILL.md frontmatter needs \`name:\``);
    assert.match(frontmatter, /^description: \S/m, `${name}/SKILL.md frontmatter needs \`description:\``);
  });
}
