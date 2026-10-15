#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPONENTS = ['product', 'sdk', 'cli', 'dev-kit', 'docs', 'marketplace'];

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function requireEvidence(component) {
  if (typeof component.evidence !== 'string' || component.evidence.trim().length < 12) throw new Error(`${component.name}: require a concrete decision and compatibility evidence.`);
}

function inspectComponent(component, manifestDir, isPlugin = false) {
  if (!component.path || !/^[a-f0-9]{40}$/.test(component.sha ?? '')) throw new Error(`${component.name}: require checkout path and immutable full SHA.`);
  if (!['release', 'unchanged'].includes(component.decision)) throw new Error(`${component.name}: require release/unchanged decision.`);
  requireEvidence(component);
  const root = resolve(manifestDir, component.path);
  const sha = git(root, 'rev-parse', '--verify', '--end-of-options', `${component.sha}^{commit}`);
  if (sha !== component.sha) throw new Error(`${component.name}: SHA did not resolve exactly.`);
  const pkg = JSON.parse(git(root, 'show', `${sha}:package.json`));
  const previous = component.baseline ?? component.previousTag;
  if (typeof previous !== 'string' || !/^(?:v[\w.+-]+|[a-f0-9]{40})$/.test(previous)) throw new Error(`${component.name}: require a previous tag or explicitly reviewed baseline SHA.`);
  const previousSha = git(root, 'rev-parse', '--verify', '--end-of-options', `${previous}^{commit}`);
  git(root, 'merge-base', '--is-ancestor', previousSha, sha);
  const changedFiles = git(root, 'diff', '--name-only', previousSha, sha).split('\n').filter(Boolean);
  const plugin = isPlugin ? JSON.parse(git(root, 'show', `${sha}:plugin.json`)) : null;
  if (isPlugin && (!plugin || (plugin.namespace ?? plugin.name) !== component.name || typeof plugin.version !== 'string' || !plugin.version.trim() || plugin.version !== pkg.version)) {
    throw new Error(`${component.name}: plugin namespace must match its inventory name and plugin/package versions must agree.`);
  }
  if (plugin && component.tag != null && component.tag !== `v${pkg.version}`) throw new Error(`${component.name}: provided plugin tag must match v${pkg.version}.`);
  if (component.decision === 'release') {
    if (typeof component.destination !== 'string' || !component.destination.trim()) throw new Error(`${component.name}: release requires a publishing destination.`);
    // Sites and catalogues publish from commits, independently of npm versions/tags.
    if (!isPlugin && !['docs', 'marketplace'].includes(component.name)) {
      if (component.tag !== `v${pkg.version}`) throw new Error(`${component.name}: release requires tag v${pkg.version}.`);
    }
  }
  return {
    name: component.name, sha, previousTag: previous, version: pkg.version ?? null,
    decision: component.decision, evidence: component.evidence,
    tag: component.tag ?? null, destination: component.destination ?? null,
    changedFiles,
    consumerRefs: Object.fromEntries(['package.json', 'packages/engine/package.json', 'packages/web/package.json'].filter((file) => git(root, 'ls-tree', '--name-only', sha, '--', file)).map((file) => {
      const manifest = JSON.parse(git(root, 'show', `${sha}:${file}`));
      return [file, { ...manifest.dependencies, ...manifest.devDependencies }];
    })),
    checks: Object.keys(pkg.scripts ?? {}).filter((name) => /^(test|build|typecheck|lint|contract:verify|sign-catalog|docs:generate:check|sitemap:check)/.test(name)),
    ...(plugin ? { kind: 'plugin', namespace: plugin.namespace ?? plugin.name, engineRange: plugin.engine, system: plugin.system ?? null, peerDependencies: pkg.peerDependencies ?? {} } : {}),
  };
}

function inspectCatalogue(component, manifestDir) {
  const root = resolve(manifestDir, component.path);
  const files = git(root, 'ls-tree', '-r', '--name-only', component.sha, '--', 'catalog/').split('\n').filter((file) => file.endsWith('.json'));
  const pluginIds = new Set();
  const namespaces = new Set();
  return files.map((file) => {
    const card = JSON.parse(git(root, 'show', `${component.sha}:${file}`));
    if (typeof card.pluginId !== 'string' || basename(file) !== `${card.pluginId}.json` || pluginIds.has(card.pluginId) || !Array.isArray(card.releases) || !card.releases.length) throw new Error(`${file}: require a unique pluginId and release namespace.`);
    pluginIds.add(card.pluginId);
    const namespace = card.releases[0].namespace;
    if (typeof namespace !== 'string' || !namespace.trim() || namespaces.has(namespace) || card.releases.some((release) => release.namespace !== namespace)) throw new Error(`${file}: release namespaces must agree and belong to only one card.`);
    namespaces.add(namespace);
    // Revoked-only cards still need a decision; withdrawal must not erase inventory.
    return { pluginId: card.pluginId, namespace, releases: card.releases };
  });
}

export function inspectRelease(manifest, manifestDir) {
  if (!Array.isArray(manifest.components)) throw new Error('Manifest requires components[].');
  if (!Array.isArray(manifest.plugins)) throw new Error('Manifest requires an explicit plugins[] inventory, including when empty.');
  const names = manifest.components.map((component) => component.name);
  if (new Set(names).size !== names.length || COMPONENTS.some((name) => !names.includes(name))) {
    throw new Error(`Require one entry for each of ${COMPONENTS.join(', ')}; additional editions are allowed.`);
  }
  const report = manifest.components.map((component) => inspectComponent(component, manifestDir));
  const catalogue = inspectCatalogue(manifest.components.find((component) => component.name === 'marketplace'), manifestDir);
  report.find((component) => component.name === 'marketplace').catalogue = catalogue;
  const pluginNames = manifest.plugins.map((plugin) => plugin.name);
  if (pluginNames.some((name) => typeof name !== 'string' || !name.trim()) || new Set(pluginNames).size !== pluginNames.length) throw new Error('Plugins require unique namespace names.');
  const missing = catalogue.filter((card) => !pluginNames.includes(card.namespace));
  if (missing.length) throw new Error(`Catalogue plugins missing from inventory: ${missing.map((card) => card.namespace).join(', ')}.`);
  return report.concat(manifest.plugins.map((plugin) => {
    if (plugin.decision === 'excluded') {
      requireEvidence(plugin);
      return { name: plugin.name, kind: 'plugin', decision: plugin.decision, evidence: plugin.evidence };
    }
    return inspectComponent(plugin, manifestDir, true);
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: ecosystem.mjs <release-manifest.json>');
    const path = resolve(process.argv[2]);
    console.log(JSON.stringify(inspectRelease(JSON.parse(readFileSync(path, 'utf8')), dirname(path)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
