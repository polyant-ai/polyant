---
name: release-publish
description: Use when a Polyant release promotion has merged and a post-merge tag or GitHub Release is requested.
---

# Publish a Polyant release

Publish only the immutable, reviewed `origin/main` commit. This is an irreversible remote operation: do not infer permission from a version number, a merged PR, or an earlier approval.

## Required inputs

Before running a release command, obtain all four inputs and repeat them to the human:

1. version: `vX.Y.Z`;
2. the exact verified `origin/main` SHA;
3. release-note path: `docs/releases/vX.Y.Z.md`;
4. explicit final confirmation to create the tag **and** GitHub Release for that SHA.

If a request says “latest main”, “use the current branch”, or that the SHA is unimportant, refuse publication and route to `release-preflight`. Never select a target implicitly. Do not proceed if a required input is missing, inconsistent, or stale.

## Pre-publish gate

Fetch remote state and verify that `origin/main` still resolves to the supplied SHA. Set the target only after that check:

```bash
git fetch origin
git rev-parse origin/main
RELEASE_SHA=<the already-verified exact origin/main SHA>
```

Stop if `git rev-parse origin/main` differs from `RELEASE_SHA`. Then verify all of the following before asking for the final confirmation:

- the worktree is clean;
- the release version matches the root/package version metadata and frontend version display;
- `CHANGELOG.md` and `docs/releases/vX.Y.Z.md` exist, describe the same version, and the release-note path is exactly the required input;
- `git ls-remote --tags origin "refs/tags/vX.Y.Z"` shows no remote tag;
- `npm run release:verify` succeeds;
- all required checks for the merged promotion are successful in GitHub.

Any failure, missing check, existing tag, changed `origin/main`, or uncertain metadata is a blocker. Report it; do not retarget, overwrite, delete, force-push, or publish a draft as a workaround.

## Final confirmation and publication

Show the exact version, `RELEASE_SHA`, release-note path, and verification results. Ask for final confirmation immediately before the irreversible commands. Only after an unambiguous affirmative answer, run **only** these commands:

```bash
git tag -a vX.Y.Z "$RELEASE_SHA" -m "Polyant vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "Polyant vX.Y.Z" --notes-file docs/releases/vX.Y.Z.md --target "$RELEASE_SHA"
```

If tag signing is configured, use `git tag -s` instead of `-a`. If signature creation fails, stop: never silently retry unsigned. Do not execute any of the publication commands during a dry run, review, or preparation task.

## Post-publish verification

Verify and report the immutable result:

```bash
gh release view vX.Y.Z --json tagName,targetCommitish,url,isPrerelease
```

Confirm that `tagName` is `vX.Y.Z`, `targetCommitish` is `RELEASE_SHA`, the URL is present, and `isPrerelease` has the intended value. Report any discrepancy as an incident; do not mutate the release without a new explicit human instruction.
