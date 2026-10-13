// SPDX-License-Identifier: AGPL-3.0-or-later

// Decides which CI jobs a pull request needs from the paths it changes.
//
// Reads changed paths, one per line, on stdin and prints GitHub Actions
// outputs:
//   code=true    anything outside documentation changed: run the build and
//                test jobs;
//   docker=true  an input of the Docker builds changed: build the images.
// `--all` prints both as true without reading stdin (pushes, where every job
// runs).
//
// Both lists err towards running: a path that is not clearly documentation
// counts as code, and an unknown change set (empty, or at the API's 3000-file
// cap) runs everything.

import path from "node:path";
import { fileURLToPath } from "node:url";

// The pull request files API stops listing at this many files.
export const API_FILE_LIMIT = 3000;

/**
 * Documentation no build, test or image reads. Markdown that something does
 * read is excluded on purpose:
 *   CHANGELOG.md        parsed by the web build (generate-changelog.ts);
 *   CLAUDE.md, .claude/rules/
 *                       held to a size budget by an engine unit test;
 *   packages/, examples/
 *                       markdown there can be loaded by code or tests.
 * README.md and docs/releases/ are read by the release metadata check, which
 * runs on every change in the Repository checks job.
 */
export function isDocumentation(file) {
  if (file.startsWith("docs/")) return true;
  if (file.startsWith(".claude/")) return !file.startsWith(".claude/rules/");
  if (!file.endsWith(".md")) return false;
  if (file === "CHANGELOG.md" || file === "CLAUDE.md") return false;
  if (file.startsWith("packages/") || file.startsWith("examples/")) return false;
  return true;
}

const dockerInputs = [
  /^Dockerfile\.[^/]+$/,
  /^\.dockerignore$/,
  /^docker-entrypoint\.sh$/,
  /^package(-lock)?\.json$/,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/engine\/tsconfig(\.[^/]+)?\.json$/,
  /^packages\/engine\/scripts\/copy-migrations\.mjs$/,
  /^packages\/web\/(next\.config\.ts|tsconfig\.json|postcss\.config\.mjs)$/,
  /^packages\/web\/scripts\//,
  /^scripts\/collect-plugin-system-requirements\.mjs$/,
  // The Docker job itself.
  /^\.github\/workflows\/ci\.yml$/,
];

/**
 * What the image builds depend on beyond the source that the Build job
 * already compiles: the Dockerfiles and their context rules, the manifests
 * and lockfile they install from, and the build configuration.
 */
export function isDockerInput(file) {
  return dockerInputs.some((pattern) => pattern.test(file));
}

export function classify(files) {
  const changed = files.map((file) => file.trim()).filter(Boolean);
  if (changed.length === 0 || changed.length >= API_FILE_LIMIT) {
    return { code: true, docker: true };
  }
  return {
    code: changed.some((file) => !isDocumentation(file)),
    docker: changed.some(isDockerInput),
  };
}

function print({ code, docker }) {
  process.stdout.write(`code=${code}\ndocker=${docker}\n`);
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--all")) {
    print({ code: true, docker: true });
  } else {
    const files = (await readStdin()).split("\n");
    const result = classify(files);
    console.error(`${files.filter(Boolean).length} changed paths: code=${result.code} docker=${result.docker}`);
    print(result);
  }
}
