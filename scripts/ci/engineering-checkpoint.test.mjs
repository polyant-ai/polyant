// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeImpact, validateEvidence } from './engineering-checkpoint.mjs';

test('copy-only work does not trigger engine or security audits; route changes reach collateral checks', () => {
  const copy = changeImpact(['packages/web/src/lib/i18n/locales/en.json']);
  assert.equal(copy.checks.length, 1);
  assert.equal(copy.browser, false);
  const route = changeImpact(['packages/engine/src/server/tools/tools.controller.ts']);
  assert.ok(route.checks.some((check) => check.startsWith('routes:')));
  assert.ok(route.checks.some((check) => check.startsWith('authorization:')));
  assert.match(route.ecosystem.sdk, /public tool/);
  assert.equal(route.browser, true);
  assert.equal(changeImpact(['README.md']).checks.length, 0);
});

test('evidence belongs to the current head, and every ecosystem component needs a decision', () => {
  const sha = 'a'.repeat(40);
  const body = `Reviewed-commit: ${sha}\n` + ['verification', 'maintainability', 'security', 'sdk', 'cli', 'dev-kit', 'docs'].map((key) => `- ${key}: no-impact: only internal CI tooling changed`).join('\n');
  assert.deepEqual(validateEvidence(body, sha), []);
  assert.ok(validateEvidence(body, 'b'.repeat(40)).length);
  assert.ok(validateEvidence(body.replace('- sdk: no-impact: only internal CI tooling changed', '- sdk: TODO'), sha).some((error) => error.startsWith('sdk:')));
  assert.ok(validateEvidence(`<!-- ${body} -->`, sha).length);
  assert.ok(validateEvidence(body.replace('Reviewed-commit', 'Reviewed-com<!-- hidden -->mit'), sha).length);
  assert.ok(validateEvidence(body.replace('- cli:', '> - cli:'), sha).some((error) => error.startsWith('cli:')));
});
