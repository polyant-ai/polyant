#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPONENTS = ['product', 'sdk', 'cli', 'dev-kit', 'docs'];

export function inspectRelease(manifest, manifestDir) {
  if (!Array.isArray(manifest.components)) throw new Error('Manifest requires components[].');
  const names = manifest.components.map((component) => component.name);
  if (new Set(names).size !== names.length || COMPONENTS.some((name) => !names.includes(name))) {
    throw new Error(`Require one entry for each of ${COMPONENTS.join(', ')}; additional editions are allowed.`);
  }
  return manifest.components.map((component) => {
    if (!component.path || !/^[a-f0-9]{40}$/.test(component.sha ?? '')) throw new Error(`${component.name}: require checkout path and immutable full SHA.`);
    if (!['release', 'unchanged'].includes(component.decision) || typeof component.evidence !== 'string' || component.evidence.trim().length < 12) {
      throw new Error(`${component.name}: require release/unchanged decision and compatibility evidence.`);
    }
    const root = resolve(manifestDir, component.path);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const sha = git('rev-parse', '--verify', '--end-of-options', `${component.sha}^{commit}`);
    if (sha !== component.sha) throw new Error(`${component.name}: SHA did not resolve exactly.`);
    const pkg = JSON.parse(git('show', `${sha}:package.json`));
    const previous = component.baseline ?? component.previousTag;
    if (typeof previous !== 'string' || !/^(?:v[\w.+-]+|[a-f0-9]{40})$/.test(previous)) throw new Error(`${component.name}: require a previous tag or explicitly reviewed baseline SHA.`);
    const previousSha = git('rev-parse', '--verify', '--end-of-options', `${previous}^{commit}`);
    git('merge-base', '--is-ancestor', previousSha, sha);
    const changedFiles = git('diff', '--name-only', previousSha, sha).split('\n').filter(Boolean);
    if (component.decision === 'release') {
      if (typeof component.destination !== 'string' || !component.destination.trim()) throw new Error(`${component.name}: release requires a publishing destination.`);
      // Docs ships a site/PDF from a pinned commit, not an npm version tag.
      if (component.name !== 'docs' && component.tag !== `v${pkg.version}`) throw new Error(`${component.name}: release requires tag v${pkg.version}.`);
    }
    return {
      name: component.name, sha, previousTag: previous, version: pkg.version,
      decision: component.decision, evidence: component.evidence,
      tag: component.tag ?? null, destination: component.destination ?? null,
      changedFiles,
      consumerRefs: Object.fromEntries(['package.json', 'packages/engine/package.json', 'packages/web/package.json'].filter((file) => git('ls-tree', '--name-only', sha, '--', file)).map((file) => {
        const manifest = JSON.parse(git('show', `${sha}:${file}`));
        return [file, { ...manifest.dependencies, ...manifest.devDependencies }];
      })),
      checks: Object.keys(pkg.scripts ?? {}).filter((name) => /^(test|build|typecheck|docs:generate:check|sitemap:check)/.test(name)),
    };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: ecosystem.mjs <release-manifest.json>');
    const path = resolve(process.argv[2]);
    console.log(JSON.stringify(inspectRelease(JSON.parse(readFileSync(path, 'utf8')), dirname(path)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
