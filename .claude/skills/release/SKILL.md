---
name: release
description: Use when auditing, preparing, promoting, tagging, or publishing a Polyant release, or when changing release metadata and notes.
---

# Release workflow

Use repository release scripts as the authority. A release request does not imply permission
to mutate protected branches or remote state.

## Audit

Start read-only. Fetch current refs, confirm a clean worktree, identify the previous tag and
candidate `develop` SHA, inspect the full change range, CI, migrations, public contracts,
README, upgrade notes, and release-note coverage. Run:

```bash
npm run release:audit
npm run release:verify
```

If evidence is missing or inconsistent, report the exact blocker. Do not repair or publish
while auditing.

## Prepare

Preparation requires an explicit SemVer version and agreed target. Run the repository
preparation script, review its diff, and update only release material supported by the
inspected commit range. Keep package metadata, lockfile, About/version display, changelog,
and `docs/releases/vX.Y.Z.md` consistent. Re-running preparation for the same version must
produce no unexplained changes.

Run release verification and relevant tests. Obtain human editorial approval before creating
a release-preparation commit or PR. Promotion from `develop` to `main` is a separately
reviewed PR and is never force-pushed or merged by inference.

## Publish

Publishing requires, immediately beforehand, explicit confirmation of all three values:

- tag `vX.Y.Z`;
- exact immutable `origin/main` SHA;
- release-note path `docs/releases/vX.Y.Z.md`.

Fetch again and stop if the SHA, version metadata, checks, or notes differ. Refuse an existing
tag; never move, replace, or silently publish it unsigned. Only after final confirmation may
the exact tag be pushed and the GitHub Release created. Verify the published tag, target SHA,
URL, and prerelease state, then report them.
