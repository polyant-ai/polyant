// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { COMPONENTS, inspectRelease } from './ecosystem.mjs';

test('release coordination pins source versions and rejects omitted components or mutable candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-ecosystem-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0', scripts: { test: 'node --test' } }));
    git('add', 'package.json'); git('commit', '-qm', 'initial'); git('tag', 'v1.0.0');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.0', dependencies: { sdk: 'git+https://example.invalid/sdk#v1.0.0' } }));
    git('add', 'package.json'); git('commit', '-qm', 'candidate');
    const sha = git('rev-parse', 'HEAD');
    const components = COMPONENTS.map((name) => ({ name, path: root, sha, previousTag: 'v1.0.0', decision: 'release', tag: 'v1.1.0', destination: 'GitHub tag and Release', evidence: 'Consumer contract tests passed on the pinned candidate.' }));
    const report = inspectRelease({ components }, root);
    assert.equal(report.length, 5);
    assert.deepEqual(report[0].changedFiles, ['package.json']);
    assert.equal(report[0].consumerRefs['package.json'].sdk, 'git+https://example.invalid/sdk#v1.0.0');
    assert.throws(() => inspectRelease({ components: components.slice(1) }, root), /each/);
    assert.throws(() => inspectRelease({ components: components.map((c) => ({ ...c, sha: 'HEAD' })) }, root), /immutable/);
    assert.throws(() => inspectRelease({ components: components.map((c) => ({ ...c, tag: 'v9.0.0' })) }, root), /tag v1.1.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
