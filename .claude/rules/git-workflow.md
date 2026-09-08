---
description: "Enforce git workflow: atomic commits, branch strategy, PR hygiene"
globs: ["**/*"]
alwaysApply: true
---

# Git Workflow Rules

## MUST (violations block PR)

### Commits
- **Every commit MUST carry a `Signed-off-by` line** (`git commit -s`). The DCO check
  (`.github/workflows/dco.yml`) runs on every pull request and fails the whole PR if a
  single commit is missing it — see CONTRIBUTING.md → "Sign your work (DCO)". Adding it
  afterwards means rewriting the range, so sign as you go
- Commits MUST be atomic: one commit = one logical change
- Commit messages in English, format: `type(scope): description` (conventional commits)
- Valid types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `ci`
- Never commit: `.env`, `node_modules/`, `.DS_Store`, build artifacts
- Never commit generated files (lockfiles excluded — those must be committed)

### Branches
- `develop` is the integration branch; `main` carries releases. A feature branch starts
  from `origin/develop` and returns there by PR: `feat/<short-description>`,
  `fix/<short-description>`. CI agrees — the secret scanner diffs against
  `origin/${{ github.base_ref || 'develop' }}`
- `develop` → `main` is a release promotion, not ordinary work: it goes through the
  `release-*` skills
- Never push directly to `main` or `develop` — always via PR
- Branch names in kebab-case, max 50 characters
- Check the current branch BEFORE every commit: the working directory may be shared with
  another session that has moved HEAD

### Pull Requests
- PR title follows conventional commits: `feat(scope): description`
- PR MUST have a description: what changes, why, how to test
- PR MUST pass CI (lint, test, build) before merge
- Review required for production code

## SHOULD (warnings)

- Squash merge for feature branches (clean history)
- Rebase onto `develop` before merge (avoid useless merge commits)
- PR ≤400 lines of code changed (excluding generated/lock files)
- Draft PR for work-in-progress (signals it's not ready for review)
- Link issue/ticket in the PR description
