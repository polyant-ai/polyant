---
name: release-preflight
description: Use when auditing release readiness, analysing commits or changes, checking develop/main divergence, version drift, migrations, public-contract impact, or CI readiness before a Polyant release.
---

# Polyant release preflight

Operate in **read-only mode**. Establish evidence for a human release decision; do not alter repository or remote state.

## Audit

Run these commands before drawing conclusions:

```bash
git fetch origin
git status --short --branch
git rev-list --left-right --count origin/main...origin/develop
git tag --sort=-version:refname
```

Select the previous release tag from the tag list. If one exists, inspect candidate changes with:

```bash
git log --oneline "$PREVIOUS_TAG"..origin/develop
```

For the first release, state that no prior tag exists and analyse the relevant history from its agreed baseline instead. Run:

```bash
npm run release:verify
```

Inspect the corresponding GitHub PR/checks and required CI status. Report unavailable or failing checks as blockers, never as passing by assumption.

## Required report

Return a concise, evidence-backed preflight report containing:

- current branch/worktree state, divergence counts, selected previous tag, candidate commit range, and target SHA;
- CI and `release:verify` outcomes;
- a changelog/release-note evidence inventory: user-visible features, fixes, breaking changes, dependencies, authors/PRs when available, and items that need human editorial review;
- version consistency across root/package manifests, lockfiles, Docker/runtime metadata, frontend display, README, CHANGELOG, and release-note source;
- migration, configuration, deployment, security, and rollback considerations;
- public-contract impact: documented OpenAI-compatible API, Plugin SDK/manifests, config/migrations, and any SemVer compatibility risk;
- a clear recommendation: ready to prepare, or blocked with the exact owner/action.

Do not infer release content from filenames alone: inspect the commits and affected public documentation/API surfaces.

## Hard boundary

Never edit files or run `git merge`, `git tag`, `git push`, or `gh release create` during preflight. Do not “fix conflicts while inspecting”: record the conflict risk and required resolution policy in the report. After the report and a human decision, use `release-prepare` for repository changes. Publishing belongs only to `release-publish` after its explicit confirmation gate.
