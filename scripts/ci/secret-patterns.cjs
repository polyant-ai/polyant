// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one list of secret shapes, shared by the two things that scan for them.
 *
 * `.claude/hooks/pre-commit-check.js` is a CLAUDE CODE hook, not a git hook: it
 * fires only when Claude runs `git commit` through its Bash tool. There is no
 * `.husky/`, no postinstall and no `core.hooksPath`, so a human typing the same
 * command — or anyone contributing from a fork — was never checked, while
 * CLAUDE.md described the directory as "automatic enforcement".
 *
 * The fix is not a local hook, which is bypassable with `--no-verify` and has to
 * be installed by every clone. It is a CI job (`scripts/ci/scan-secrets.cjs`)
 * that cannot be skipped. Both read this file, so the patterns cannot drift into
 * two versions.
 */
module.exports = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/, label: "OpenAI API Key" },
  { pattern: /sk_live_[a-zA-Z0-9]+/, label: "Stripe Live Key" },
  { pattern: /AKIA[A-Z0-9]{16}/, label: "AWS Access Key" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, label: "GitHub Personal Access Token" },
  { pattern: /xox[baprs]-[a-zA-Z0-9-]+/, label: "Slack Token" },
  { pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, label: "Private Key" },
  { pattern: /password\s*[:=]\s*["'][^"']{8,}["']/i, label: "Hardcoded Password" },
];
