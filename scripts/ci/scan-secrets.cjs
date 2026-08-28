#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scan a git diff range for secret-shaped strings. Exit 1 on a hit.
 *
 *   node scripts/ci/scan-secrets.cjs <base-ref>
 *
 * Only ADDED lines are considered: a removed secret is a secret being taken out,
 * and flagging it would make the very commit that fixes a leak un-mergeable.
 *
 * This is where the check belongs. The equivalent Claude Code hook fires only
 * when Claude commits; a `husky` hook would be skippable with `--no-verify` and
 * would need installing by every clone. A CI job is neither.
 */

const { execSync } = require("child_process");
const patterns = require("./secret-patterns.cjs");

const base = process.argv[2];
if (!base) {
  process.stderr.write("usage: scan-secrets.cjs <base-ref>\n");
  process.exit(2);
}

let diff;
try {
  diff = execSync(`git diff --unified=0 ${base}...HEAD`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  process.stderr.write(`could not diff against "${base}": ${err.message}\n`);
  process.exit(2);
}

const added = diff
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1));

const findings = [];
for (const { pattern, label } of patterns) {
  const hits = added.filter((line) => pattern.test(line));
  // Report the LABEL and the line number's worth of context, never the value.
  if (hits.length > 0) findings.push({ label, count: hits.length });
}

if (findings.length > 0) {
  process.stderr.write("\n⛔ Potential secrets in added lines:\n");
  for (const { label, count } of findings) {
    process.stderr.write(`   - ${label} (${count} line${count === 1 ? "" : "s"})\n`);
  }
  process.stderr.write(
    "\nThe value is deliberately not printed. Remove it, rotate it, and use an\n" +
      "environment variable. If this is a false positive, narrow the pattern in\n" +
      "scripts/ci/secret-patterns.cjs rather than skipping the job.\n",
  );
  process.exit(1);
}

process.stdout.write(`No secret-shaped strings in ${added.length} added lines.\n`);
