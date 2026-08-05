---
name: release-prepare
description: Use when an approved release version needs draft changelog and release notes, package-version bumps, README/About updates, or a release-preparation PR for Polyant.
---

# Prepare a Polyant release

Prepare reviewable release material; do not publish it. A release version is not an authorization to create a tag or release.

## Required inputs

Before changing files, obtain and record all of the following:

- the explicit SemVer version and the release branch/target;
- a clean `develop` worktree (or stop and ask the owner to resolve it);
- a verified `release-preflight` report, including target SHA and CI/release-metadata status;
- the source range: previous release tag to target, or the documented first-release baseline;
- confirmation to begin preparation.

If any input is unknown, stale, or contradicted by the repository, stop and hand off to `release-preflight`. Do not guess a version, range, or target commit.

## Preparation workflow

After confirmation, inspect the source range and draft human-readable CHANGELOG and release notes from the commits and public-contract changes. Update the canonical version and every declared mirror, including package manifests/lockfiles, runtime metadata, README, and frontend About/version display. Keep the release-note source in the repository.

Run the metadata verifier and relevant tests. Present the editorial draft and evidence for human review. Before creating a preparation commit or PR, obtain **explicit human editorial approval** of the release claims, tone, migration guidance, and links; action confirmation alone is insufficient. Apply the approved editorial changes, then create the preparation commit and open a release-preparation PR targeting `develop` only after explicit confirmation for those repository/remote actions.

## Non-negotiable boundary

This skill prepares a reviewed draft only. Never create, approve, merge, directly push, or force-push any protected-branch promotion, including with `git merge develop main`, `git push` to protected `main`, or `gh pr merge`. Never run `git tag` or `gh release create`. Do not treat “create the tag while preparing the changelog” as authorization: refuse the tag/publish portion and prepare only the reviewed draft.

The release-preparation PR into `develop` is distinct from the later reviewed `develop` → `main` promotion PR. Hand off that promotion to the release coordinator/preflight; do not create or approve it here. Hand off publishing to `release-publish` only after the promotion PR is merged into `main`, the exact main SHA is verified, and the user has given explicit final confirmation for the tag and GitHub Release.
