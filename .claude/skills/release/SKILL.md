---
name: release
description: Use when preparing, promoting, tagging, or publishing a Polyant versioned release, including a request to merge develop into main or create a GitHub Release.
---

# Polyant release coordinator

Choose and load **exactly one** subskill before doing any release work, in this order:

1. Any audit, readiness, CI, branch-divergence, or uncertainty concern → `release-preflight`.
2. Otherwise, a post-merge tag or GitHub Release → `release-publish`.
3. Otherwise, an approved version, release draft, version bump, README/About/roadmap change, or release-preparation PR → `release-prepare`.

Do not inspect, edit, or run release commands until the selected subskill is loaded. Follow its gates exactly.

Never run release commands directly from this coordinator. In particular, do not merge, tag, push, or run `gh release create` outside `release-publish`.

A `develop` → `main` promotion or merge request routes to `release-preflight` unless its prerequisites are already verified. The coordinator never executes that merge; once verified, prepare its reviewed promotion work through `release-prepare`.

If the request is ambiguous, infer the stage only from facts already established. If CI, merge status, approval, version, or target commit is unknown, route to `release-preflight`; do not assume a later stage or publish. Ask the human only when the preflight cannot resolve the missing decision safely.
