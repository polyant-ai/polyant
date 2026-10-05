// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { syncSkills } from '../dev/sync-skills.mjs';

test('skill sync is repeatable, links canonical content, and reports renamed skills without deleting entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-sync-'));
  try {
    const source = join(root, '.claude/skills/alpha');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), 'canonical instructions');
    assert.deepEqual(syncSkills(root), { created: ['alpha'], obsolete: [] });
    assert.equal(realpathSync(join(root, '.agents/skills/alpha')), realpathSync(source));
    assert.deepEqual(syncSkills(root), { created: [], obsolete: [] });
    renameSync(source, join(root, '.claude/skills/beta'));
    assert.deepEqual(syncSkills(root), { created: ['beta'], obsolete: ['alpha'] });
    assert.equal(readFileSync(join(root, '.agents/skills/beta/SKILL.md'), 'utf8'), 'canonical instructions');
    assert.ok(existsSync(join(root, '.agents/skills/beta')));
    // The dangling old link remains for explicit review, rather than silent deletion.
    assert.ok(lstatSync(join(root, '.agents/skills/alpha')).isSymbolicLink());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skill sync refuses copies, wrong links and aliased destination directories without overwriting content', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-sync-'));
  try {
    for (const name of ['alpha', 'beta']) mkdirSync(join(root, '.claude/skills', name), { recursive: true });
    const collision = join(root, '.agents/skills/alpha');
    mkdirSync(collision, { recursive: true });
    writeFileSync(join(collision, 'SKILL.md'), 'keep this copy');
    assert.throws(() => syncSkills(root), /conflict/);
    assert.equal(readFileSync(join(collision, 'SKILL.md'), 'utf8'), 'keep this copy');
    assert.equal(existsSync(join(root, '.agents/skills/beta')), false);
    rmSync(collision, { recursive: true });
    symlinkSync('../../.claude/skills/beta', collision);
    assert.throws(() => syncSkills(root), /conflict/);
    rmSync(join(root, '.agents/skills'), { recursive: true });
    symlinkSync('../.claude/skills', join(root, '.agents/skills'));
    assert.throws(() => syncSkills(root), /ordinary directory/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
