#!/usr/bin/env node

/**
 * PreToolUse hook: Block commits containing hardcoded secrets.
 *
 * Receives tool metadata as JSON on stdin.
 * Exit 0 = allow, Exit 2 = block.
 * Outputs blocking reason to stderr.
 */

const { execSync } = require("child_process");
const path = require("path");

// The patterns live in ONE place, shared with the CI job that is the real
// enforcement — this hook only fires when CLAUDE runs the commit. See the
// docblock in that file.
const SECRET_PATTERNS = require(
  path.join(__dirname, "..", "..", "scripts", "ci", "secret-patterns.cjs"),
);

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  try {
    const data = JSON.parse(input);
    const command = data.input?.command || "";

    // Only check git commit commands
    if (!command.includes("git commit")) {
      process.exit(0);
    }

    // Check staged files for secrets
    let stagedDiff;
    try {
      stagedDiff = execSync("git diff --cached", {
        encoding: "utf-8",
        timeout: 5000,
      });
    } catch {
      process.exit(0); // can't get diff — allow
    }

    const findings = [];
    for (const { pattern, label } of SECRET_PATTERNS) {
      if (pattern.test(stagedDiff)) {
        findings.push(label);
      }
    }

    if (findings.length > 0) {
      process.stderr.write(
        `\n⛔ BLOCKED: Potential secrets detected in staged changes:\n`
      );
      for (const finding of findings) {
        process.stderr.write(`   - ${finding}\n`);
      }
      process.stderr.write(
        `\nRemove secrets before committing. Use environment variables instead.\n`
      );
      process.exit(2); // Block the commit
    }
  } catch {
    // Parse error — allow (non-blocking)
  }

  process.exit(0);
}

main();
