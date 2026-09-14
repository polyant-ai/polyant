#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Collect what the plugins in a build need from the runtime IMAGE.
 *
 * Runs in the Docker `plugins` stage, which is the only place that sees every
 * plugin in the build before the runtime stage exists. It writes three plain
 * files the runtime stage consumes with `xargs` and a sourced env file, so the
 * Dockerfile needs no dynamic FROM and no conditional logic.
 *
 * Usage: node collect-plugin-system-requirements.mjs <pluginsDir> <outDir>
 *
 * Outputs, always created even when empty:
 *   apk.txt        one Alpine package per line
 *   npm-global.txt one npm package per line
 *   env.sh         `export KEY=value` lines, sourced by docker-entrypoint.sh
 *
 * A plugin is trusted by the act of including it in the build: these values
 * become install arguments. The script only rejects shapes that would corrupt
 * the output files (whitespace, newlines, shell metacharacters in a key).
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const [, , pluginsDir, outDir] = process.argv;
if (!pluginsDir || !outDir) {
  console.error("usage: collect-plugin-system-requirements.mjs <pluginsDir> <outDir>");
  process.exit(2);
}

/** A package name that survives `xargs` and an `apk add` argument list. */
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._@/+-]*$/;
/** An environment variable name; the value is quoted, so only the key is bounded. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const apk = new Set();
const npmGlobal = new Set();
const env = new Map();

function fail(plugin, message) {
  console.error(`plugin "${plugin}": ${message}`);
  process.exit(1);
}

const roots = existsSync(pluginsDir)
  ? readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  : [];

for (const entry of roots) {
  const manifestPath = join(pluginsDir, entry.name, "plugin.json");
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(entry.name, `plugin.json is not valid JSON: ${err.message}`);
  }

  const system = manifest.system ?? {};
  for (const pkg of system.apk ?? []) {
    if (!PACKAGE_RE.test(pkg)) fail(entry.name, `invalid apk package name: ${JSON.stringify(pkg)}`);
    apk.add(pkg);
  }
  for (const pkg of system.npmGlobal ?? []) {
    if (!PACKAGE_RE.test(pkg)) fail(entry.name, `invalid npm package name: ${JSON.stringify(pkg)}`);
    npmGlobal.add(pkg);
  }
  for (const [key, value] of Object.entries(system.env ?? {})) {
    if (!ENV_KEY_RE.test(key)) fail(entry.name, `invalid env key: ${JSON.stringify(key)}`);
    if (typeof value !== "string") fail(entry.name, `env value for ${key} is not a string`);
    const existing = env.get(key);
    // Two plugins disagreeing on one variable is a deploy the operator has to
    // resolve: silently keeping one would make the loser fail at call time,
    // far from here.
    if (existing !== undefined && existing !== value) {
      fail(entry.name, `env ${key} conflicts with an earlier plugin (${existing} vs ${value})`);
    }
    env.set(key, value);
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "apk.txt"), [...apk].sort().join("\n") + (apk.size ? "\n" : ""));
writeFileSync(
  join(outDir, "npm-global.txt"),
  [...npmGlobal].sort().join("\n") + (npmGlobal.size ? "\n" : ""),
);
writeFileSync(
  join(outDir, "env.sh"),
  [...env]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'`)
    .join("\n") + (env.size ? "\n" : ""),
);

console.log(
  `plugin system requirements: ${apk.size} apk, ${npmGlobal.size} npm-global, ${env.size} env`,
);
