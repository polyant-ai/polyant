// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('Claude Code and Codex discover the same canonical skills and working agreement', () => {
  assert.match(readFileSync(resolve(root, 'AGENTS.md'), 'utf8'), /CLAUDE\.md/);
  const canonical = resolve(root, '.claude/skills');
  const skills = readdirSync(canonical, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(skills.length > 0);
  assert.deepEqual(readdirSync(resolve(root, '.agents/skills')).sort(), skills.map(({ name }) => name).sort(), 'Missing or obsolete Codex skill entries; run npm run skills:sync and review obsolete entries.');
  for (const { name } of skills) {
    assert.ok(lstatSync(resolve(root, '.agents/skills', name)).isSymbolicLink(), `${name} must be a link, not a separate copy.`);
    assert.equal(realpathSync(resolve(root, '.agents/skills', name)), realpathSync(resolve(canonical, name)));
    const text = readFileSync(resolve(canonical, name, 'SKILL.md'), 'utf8');
    assert.match(text, /^---\nname: /);
    assert.match(text, /\ndescription: .+/);
  }
});
