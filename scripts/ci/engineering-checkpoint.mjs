#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function changeImpact(files) {
  const has = (pattern) => files.some((file) => pattern.test(file));
  const engine = has(/^packages\/engine\//);
  const web = has(/^packages\/web\//);
  const contract = has(/^packages\/engine\/src\/(plugin-system|agents\/tools|hooks|dev-mode|server|instances|skills)\//);
  const configuration = has(/^packages\/engine\/src\/(database|instances|config\.|skills|plugin-system|governance|retention|budgets)/);
  const security = has(/(?:^|\/)(auth|authz|two-factor|credentials|secrets|governance|dev-mode|plugin-system|attachments)(?:\/|\.)|\.github\/workflows\//);
  return {
    files: files.length,
    browser: has(/^packages\/web\/(?:src\/(?!lib\/i18n\/locales\/).*\.[jt]sx?$|e2e\/|next\.config|playwright\.config)/) || has(/^packages\/engine\/src\/(auth|authz|server|organizations)\//),
    checks: [
      ...(engine ? ['engine: focused tests, typecheck, lint'] : []),
      ...(web ? ['web: focused tests, typecheck, lint; locales for copy; browser for changed flows'] : []),
      ...(has(/^packages\/engine\/src\/server\//) ? ['routes: OpenAPI artifacts and web proxy guardrails; real HTTP for framework-shaped input'] : []),
      ...(configuration ? ['configuration: export/import, snapshots, defaults, migrations and purge coverage'] : []),
      ...(has(/^packages\/engine\/src\/(server|authz|organizations|database)\//) ? ['authorization: permission catalog, role defaults, audit and allow/deny behavior'] : []),
      ...(security ? ['security: review the changed trust boundary and its negative-path proof'] : []),
    ],
    ecosystem: {
      sdk: contract ? 'inspect public tool/hook/context and dev protocol contracts' : 'no path signal; confirm against behavior',
      cli: contract ? 'inspect commands, API responses and configuration round trips' : 'no path signal; confirm against behavior',
      'dev-kit': contract ? 'inspect pinned consumers, templates, skills and examples' : 'no path signal; confirm against behavior',
      docs: engine || web || has(/^(README|CHANGELOG|docker-compose|\.env\.example)/) ? 'inspect user-visible behavior, defaults, setup and generated references' : 'no path signal; confirm against behavior',
    },
  };
}

export function validateEvidence(body, head) {
  // Templates and quoted historical evidence are not an attestation for this head.
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/^>.*$/gm, '').replace(/```[\s\S]*?```/g, '');
  const errors = [];
  if (!new RegExp(`^Reviewed-commit: ${head}$`, 'm').test(text)) errors.push('Reviewed-commit must name the current full PR head SHA.');
  for (const key of ['verification', 'maintainability', 'security', 'sdk', 'cli', 'dev-kit', 'docs']) {
    const line = text.match(new RegExp(`^- ${key}: (.+)$`, 'm'))?.[1]?.trim();
    if (!line || line.length < 12 || /^(TODO|TBD|<|\[|pending\b)/i.test(line)) errors.push(`${key}: record evidence, or no-impact with a concrete reason.`);
  }
  return errors;
}

export function inventory(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const localeDir = resolve(root, 'packages/web/src/lib/i18n/locales');
  const locales = readdirSync(localeDir).filter((name) => name.endsWith('.json'));
  const dictionaries = locales.map((name) => ({ name, content: JSON.parse(readFileSync(resolve(localeDir, name), 'utf8')) }));
  const keys = new Set(dictionaries.flatMap(({ content }) => Object.keys(content)));
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    testFiles: files.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)).length,
    guardrailFiles: files.filter((file) => /guardrail.*test\./.test(file)).length,
    locales: dictionaries.map(({ name, content }) => ({ name, keys: Object.keys(content).length, missing: [...keys].filter((key) => !(key in content)) })),
    // Counts are an inventory, not quality scores or a substitute for executed tests.
  };
}

export function main(args, root = process.cwd()) {
  if (args.length === 1 && args[0] === '--inventory') {
    console.log(JSON.stringify(inventory(root), null, 2));
    return;
  }
  if (args[0] !== '--base' || !args[1] || (args.length !== 2 && !(args.length === 4 && args[2] === '--event'))) {
    throw new Error('Usage: engineering-checkpoint.mjs --base <ref> [--event <GitHub event JSON>] | --inventory');
  }
  const base = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${args[1]}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  console.log(JSON.stringify({ head, base, ...changeImpact(files) }, null, 2));
  if (args[3]) {
    const event = JSON.parse(readFileSync(args[3], 'utf8'));
    if (!event.pull_request || event.pull_request.head.sha !== head) throw new Error('Event and checked-out PR head disagree.');
    const errors = validateEvidence(event.pull_request.body ?? '', head);
    if (errors.length) throw new Error(errors.join('\n'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
