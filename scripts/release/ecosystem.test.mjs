// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { COMPONENTS, inspectRelease } from './ecosystem.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-ecosystem-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function repository(name, files) {
    const path = join(root, name);
    mkdirSync(path);
    const git = (...args) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    function commit(contents) {
      for (const [file, value] of Object.entries(contents)) {
        mkdirSync(dirname(join(path, file)), { recursive: true });
        writeFileSync(join(path, file), JSON.stringify(value));
      }
      git('add', '.'); git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD');
    }
    return { path, git, commit, sha: commit(files) };
  }
  const core = repository('core', { 'package.json': { version: '1.0.0' } });
  core.git('tag', 'v1.0.0');
  core.sha = core.commit({ 'package.json': { version: '1.1.0', dependencies: { sdk: 'git+https://example.invalid/sdk#v1.0.0' }, scripts: { test: 'node --test' } } });
  const market = repository('catalogue-source', { 'package.json': { name: 'example-marketplace', private: true, scripts: { 'contract:verify': 'node verify.mjs' } } });
  const manifest = { components: COMPONENTS.map((name) => name === 'marketplace'
    ? { name, path: market.path, sha: market.sha, baseline: market.sha, decision: 'release', destination: 'signed catalogue and site', evidence: 'Catalogue contract and publication receipts reviewed.' }
    : { name, path: core.path, sha: core.sha, previousTag: 'v1.0.0', decision: 'release', tag: 'v1.1.0', destination: 'GitHub tag and Release', evidence: 'Consumer contract tests passed on this candidate.' }), plugins: [] };
  function cards(files) {
    market.sha = market.commit(files);
    manifest.components.find((component) => component.name === 'marketplace').sha = market.sha;
  }
  return { root, repository, core, market, manifest, cards };
}

const card = (namespace, status = 'published') => ({ pluginId: `example.${namespace}`, releases: [{ namespace, version: '1.1.0', status, engineRange: '>=1.0.0', artifactPath: `/v1/artifacts/${namespace}.tar.gz`, sha256: 'a'.repeat(64) }] });

function addPlugin(f, namespace = 'alpha') {
  const plugin = f.repository(`source-${namespace}`, {
    'package.json': { version: '1.1.0', devDependencies: { '@polyant-ai/plugin-sdk': 'git+https://example.invalid/sdk#v1.0.0' }, peerDependencies: { '@polyant-ai/plugin-sdk': '*' }, scripts: { typecheck: 'tsc --noEmit', prepare: 'node -e "throw Error(\'inventory must not execute prepare\')"' } },
    'plugin.json': { name: namespace, namespace, version: '1.1.0', engine: '>=1.0.0' },
  });
  f.manifest.plugins.push({ name: namespace, path: plugin.path, sha: plugin.sha, baseline: plugin.sha, decision: 'unchanged', evidence: 'Existing bundle remains compatible with this candidate.' });
  return plugin;
}

test('release coordination requires every core component, explicit plugin scope and immutable candidates', (t) => {
  const f = fixture(t);
  const report = inspectRelease(f.manifest, f.root);
  assert.deepEqual(report.map((entry) => entry.name), COMPONENTS);
  assert.deepEqual(report[0].changedFiles, ['package.json']);
  assert.equal(report[0].consumerRefs['package.json'].sdk, 'git+https://example.invalid/sdk#v1.0.0');
  const docs = f.manifest.components.find((entry) => entry.name === 'docs');
  delete docs.tag;
  assert.equal(inspectRelease(f.manifest, f.root).find((entry) => entry.name === 'docs').tag, null);
  assert.throws(() => inspectRelease({ components: f.manifest.components }, f.root), /explicit plugins/);
  assert.throws(() => inspectRelease({ ...f.manifest, components: f.manifest.components.filter((entry) => entry.name !== 'marketplace') }, f.root), /each/);
  assert.throws(() => inspectRelease({ ...f.manifest, components: f.manifest.components.map((entry) => ({ ...entry, sha: 'HEAD' })) }, f.root), /immutable/);
  assert.throws(() => inspectRelease({ ...f.manifest, components: f.manifest.components.map((entry) => ({ ...entry, tag: 'v9.0.0' })) }, f.root), /tag v1.1.0/);
});

test('an unversioned marketplace and plugins are read at pinned commits without executing their code', (t) => {
  const f = fixture(t);
  f.cards({ 'catalog/example.alpha.json': card('alpha') });
  const plugin = addPlugin(f);
  writeFileSync(join(plugin.path, 'plugin.json'), JSON.stringify({ namespace: 'wrong-working-tree', version: '9.0.0' }));
  Object.assign(f.manifest.plugins[0], { decision: 'release', destination: 'signed catalogue bundle from the pinned source' });
  const report = inspectRelease(f.manifest, f.root);
  const marketplace = report.find((entry) => entry.name === 'marketplace');
  assert.equal(marketplace.version, null);
  assert.equal(marketplace.tag, null);
  assert.ok(marketplace.checks.includes('contract:verify'));
  assert.equal(marketplace.catalogue[0].pluginId, 'example.alpha');
  const consumer = report.find((entry) => entry.kind === 'plugin');
  assert.equal(consumer.namespace, 'alpha');
  assert.equal(consumer.version, '1.1.0');
  assert.equal(consumer.tag, null);
  f.manifest.plugins[0].tag = 'v9.0.0';
  assert.throws(() => inspectRelease(f.manifest, f.root), /provided plugin tag/);
  assert.equal(consumer.engineRange, '>=1.0.0');
  assert.equal(consumer.consumerRefs['package.json']['@polyant-ai/plugin-sdk'], 'git+https://example.invalid/sdk#v1.0.0');
  assert.equal(consumer.peerDependencies['@polyant-ai/plugin-sdk'], '*');
});

test('a future catalogue addition cannot disappear from the reviewed plugin inventory', (t) => {
  const f = fixture(t);
  f.cards({ 'catalog/example.alpha.json': card('alpha') });
  assert.throws(() => inspectRelease(f.manifest, f.root), /missing from inventory: alpha/);
  addPlugin(f);
  assert.doesNotThrow(() => inspectRelease(f.manifest, f.root));
  f.cards({ 'catalog/example.future.json': card('future') });
  assert.throws(() => inspectRelease(f.manifest, f.root), /missing from inventory: future/);
});

test('plugin namespace and package version must match the pinned source, and duplicate decisions fail', (t) => {
  const f = fixture(t);
  const plugin = addPlugin(f);
  f.manifest.plugins[0].name = 'another';
  assert.throws(() => inspectRelease(f.manifest, f.root), /namespace/);
  f.manifest.plugins[0].name = 'alpha';
  f.manifest.plugins[0].sha = plugin.commit({ 'plugin.json': { namespace: 'alpha', version: '2.0.0' } });
  assert.throws(() => inspectRelease(f.manifest, f.root), /versions must agree/);
  f.manifest.plugins[0].sha = plugin.commit({ 'plugin.json': null });
  assert.throws(() => inspectRelease(f.manifest, f.root), /namespace/);
  f.manifest.plugins.push({ ...f.manifest.plugins[0] });
  assert.throws(() => inspectRelease(f.manifest, f.root), /unique namespace/);
});

test('withdrawn plugins still need an explicit reason, and shared or inconsistent catalogue namespaces fail', (t) => {
  const f = fixture(t);
  f.cards({ 'catalog/example.alpha.json': card('alpha', 'revoked') });
  assert.throws(() => inspectRelease(f.manifest, f.root), /missing from inventory: alpha/);
  f.manifest.plugins = [{ name: 'alpha', decision: 'excluded', evidence: '' }];
  assert.throws(() => inspectRelease(f.manifest, f.root), /evidence/);
  f.manifest.plugins[0].evidence = 'All releases are revoked; no consumer may newly install them.';
  assert.equal(inspectRelease(f.manifest, f.root).at(-1).decision, 'excluded');
  f.cards({ 'catalog/example.other.json': { ...card('alpha'), pluginId: 'example.other' } });
  assert.throws(() => inspectRelease(f.manifest, f.root), /only one card/);
  const g = fixture(t);
  g.cards({ 'catalog/example.alpha.json': { ...card('alpha'), releases: [...card('alpha').releases, ...card('different').releases] } });
  assert.throws(() => inspectRelease(g.manifest, g.root), /namespaces must agree/);
});
