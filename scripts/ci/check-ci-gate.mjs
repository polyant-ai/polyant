// SPDX-License-Identifier: AGPL-3.0-or-later

// Fails when the `CI` gate job of a workflow does not need every other job.
//
// Branch protection requires the gate alone, so a job left out of its `needs`
// can fail without blocking a merge. This reads the workflow text directly
// (no YAML dependency) and only understands the shapes ci.yml uses: two-space
// job ids under a top-level `jobs:` key, and `needs:` written either inline
// (`needs: [a, b]`) or as a block list.
//
// Usage: node scripts/ci/check-ci-gate.mjs .github/workflows/ci.yml [gate-job-id]

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Returns `{ jobs: Map<id, string[]> }` with each job's body lines. */
export function parseJobs(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start === -1) throw new Error("no top-level `jobs:` key");

  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !line.startsWith("#")) break; // next top-level key
    const id = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (id) {
      current = id[1];
      jobs.set(current, []);
    } else if (current) {
      jobs.get(current).push(line);
    }
  }
  return jobs;
}

/** Reads a job's `needs` (inline list, block list or a single id) and `if`. */
export function readJob(body) {
  const needs = [];
  let condition = null;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const inline = line.match(/^ {4}needs:\s*\[([^\]]*)\]/);
    const single = line.match(/^ {4}needs:\s*([A-Za-z0-9_-]+)\s*(#.*)?$/);
    if (inline) {
      needs.push(...inline[1].split(",").map((item) => item.trim()).filter(Boolean));
    } else if (single) {
      needs.push(single[1]);
    } else if (/^ {4}needs:\s*(#.*)?$/.test(line)) {
      for (let j = i + 1; j < body.length; j++) {
        const item = body[j].match(/^ {6}- ([A-Za-z0-9_-]+)\s*(#.*)?$/);
        if (!item) break;
        needs.push(item[1]);
      }
    }
    const ifLine = line.match(/^ {4}if:\s*(.+?)\s*$/);
    if (ifLine) condition = ifLine[1];
  }
  return { needs, condition };
}

/** Returns the problems with the gate, or an empty list. */
export function checkGate(text, gateId = "ci") {
  const jobs = parseJobs(text);
  if (!jobs.has(gateId)) return [`there is no \`${gateId}\` gate job`];

  const { needs, condition } = readJob(jobs.get(gateId));
  const problems = [];
  const expected = [...jobs.keys()].filter((id) => id !== gateId);
  const missing = expected.filter((id) => !needs.includes(id));
  const unknown = needs.filter((id) => !jobs.has(id));
  if (missing.length > 0) problems.push(`the gate does not need: ${missing.join(", ")}`);
  if (unknown.length > 0) problems.push(`the gate needs jobs that do not exist: ${unknown.join(", ")}`);
  // Without always() the gate is skipped when a needed job fails, and a
  // skipped required check counts as passing.
  if (!condition || !/^(\$\{\{\s*)?always\(\)(\s*\}\})?$/.test(condition)) {
    problems.push("the gate must run with `if: always()`");
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file = ".github/workflows/ci.yml", gateId = "ci"] = process.argv.slice(2);
  const problems = checkGate(readFileSync(file, "utf8"), gateId);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`${file}: ${problem}`);
    process.exit(1);
  }
  console.log(`${file}: the \`${gateId}\` gate needs every job.`);
}
