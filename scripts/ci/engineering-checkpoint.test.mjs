// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeImpact, validateEvidence } from './engineering-checkpoint.mjs';

test('copy-only work does not trigger engine or security audits; route changes reach collateral checks', () => {
  const copy = changeImpact(['packages/web/src/lib/i18n/locales/en.json']);
  assert.equal(copy.checks.length, 1);
  assert.equal(copy.browser, false);
  const route = changeImpact(['packages/engine/src/server/tools/tools.controller.ts']);
  assert.ok(route.checks.some((check) => check.startsWith('routes:')));
  assert.ok(route.checks.some((check) => check.startsWith('authorization:')));
  assert.ok(route.checks.some((check) => check.startsWith('status:')));
  assert.match(route.ecosystem.sdk, /public tool/);
  assert.match(route.ecosystem.marketplace, /catalogue/);
  assert.match(route.ecosystem.plugins, /SDK pins/);
  assert.equal(route.browser, true);
  assert.equal(changeImpact(['README.md']).checks.length, 0);
  assert.match(changeImpact(['README.md']).ecosystem.plugins, /no path signal/);
  assert.match(changeImpact(['catalog/example.json']).ecosystem.marketplace, /catalogue/);
  assert.match(changeImpact(['tools/example.tool.ts']).ecosystem.plugins, /SDK pins/);
  assert.ok(changeImpact(['packages/engine/src/channels/telegram.ts']).checks.some((check) => check.startsWith('status:')));
});

test('evidence belongs to the current head, and every ecosystem component needs a decision', () => {
  const sha = 'a'.repeat(40);
  const body = `Reviewed-commit: ${sha}\n` + ['verification', 'maintainability', 'security', 'sdk', 'cli', 'dev-kit', 'docs', 'marketplace', 'plugins'].map((key) => `- ${key}: no-impact: only internal CI tooling changed`).join('\n');
  assert.deepEqual(validateEvidence(body, sha), []);
  assert.ok(validateEvidence(body, 'b'.repeat(40)).length);
  assert.ok(validateEvidence(body.replace('- sdk: no-impact: only internal CI tooling changed', '- sdk: TODO'), sha).some((error) => error.startsWith('sdk:')));
  assert.ok(validateEvidence(`<!-- ${body} -->`, sha).length);
  assert.ok(validateEvidence(body.replace('Reviewed-commit', 'Reviewed-com<!-- hidden -->mit'), sha).length);
  assert.ok(validateEvidence(body.replace('- marketplace: no-impact: only internal CI tooling changed', ''), sha).some((error) => error.startsWith('marketplace:')));
  assert.ok(validateEvidence(body.replace('- plugins: no-impact: only internal CI tooling changed', '- plugins: TODO'), sha).some((error) => error.startsWith('plugins:')));
  assert.ok(validateEvidence(body.replace('- cli:', '> - cli:'), sha).some((error) => error.startsWith('cli:')));
});

test('the candidate CLI reviews the task checkout without copying pilot commits into it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-task-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'A separate task repository.\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ namespace: 'example' }));
  git('add', '.'); git('commit', '-qm', 'task');
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./engineering-checkpoint.mjs', import.meta.url)), '--base', base], { cwd: root, encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.head, git('rev-parse', 'HEAD'));
  assert.equal(report.base, base);
  assert.equal(report.files, 1);
  assert.match(report.ecosystem.plugins, /SDK pins/);
  assert.equal(git('status', '--porcelain'), '');
});
