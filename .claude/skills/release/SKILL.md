---
name: release
description: Use when preparing, promoting, tagging, or publishing a Polyant versioned release, including a request to merge develop into main or create a GitHub Release.
---

# Polyant release coordinator

Choose and load **exactly one** subskill before doing any release work:

| Request concerns | Load |
| --- | --- |
| Audit, analysis, CI state, branch divergence, readiness, or uncertainty | `release-preflight` |
| An approved version, release drafts, version bump, README/About changes, or a release-preparation PR | `release-prepare` |
| A post-merge tag or GitHub Release | `release-publish` |

Do not inspect, edit, or run release commands until the selected subskill is loaded. Follow its gates exactly.

Never run release commands directly from this coordinator. In particular, do not merge, tag, push, or run `gh release create` outside `release-publish`.

If the request is ambiguous, infer the stage only from facts already established. If CI, merge status, approval, version, or target commit is unknown, route to `release-preflight`; do not assume a later stage or publish. Ask the human only when the preflight cannot resolve the missing decision safely.
