#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function syncSkills(root) {
  root = realpathSync(root);
  const canonical = resolve(root, '.claude/skills');
  const destination = resolve(root, '.agents/skills');
  for (const path of [resolve(root, '.agents'), destination]) {
    const entry = stat(path);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`Expected an ordinary directory: ${path}`);
  }
  const names = readdirSync(canonical, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (!names.length) throw new Error('No canonical skills found.');
  const missing = [];
  // Preflight every collision before creating any links; never replace user content.
  for (const name of names) {
    const path = resolve(destination, name);
    const entry = stat(path);
    if (!entry) { missing.push(name); continue; }
    let matches = false;
    if (entry.isSymbolicLink()) {
      try { matches = realpathSync(path) === realpathSync(resolve(canonical, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!matches) throw new Error(`Skill link conflict: ${path}. Inspect it before changing it.`);
  }
  mkdirSync(destination, { recursive: true });
  const obsolete = readdirSync(destination).filter((name) => !names.includes(name)).sort();
  for (const name of missing) symlinkSync(`../../.claude/skills/${name}`, resolve(destination, name));
  return { created: missing, obsolete };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: npm run skills:sync');
    const result = syncSkills(fileURLToPath(new URL('../../', import.meta.url)));
    console.log(JSON.stringify(result, null, 2));
    if (result.obsolete.length) {
      console.error('Review obsolete entries and remove only those belonging to intentionally removed/renamed skills.');
      process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
