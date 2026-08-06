# Polyant 1.0.0 Release and Repeatable Release Process Design

## Status

Approved on 2026-08-05. This design defines the first public Polyant release
(`v1.0.0`) and the repeatable process for all later releases.

## Goals

- Promote the current `develop` product to `main` as Polyant `v1.0.0`.
- Publish a source-only GitHub Release: no container registry, package registry,
  or additional binary assets in this release.
- Make the release understandable to users through a curated changelog, reviewed
  release notes, an accurate README, and a product About page.
- Establish Semantic Versioning for the declared public contract.
- Make the complete workflow safe and repeatable through repository-owned skills
  that any maintainer or agent can invoke.

## Non-goals

- Publishing Docker images, npm packages, SBOMs, binaries, or provenance
  attestations. These become a later, separate design when Polyant distributes
  build artifacts.
- Introducing a `staging` branch or changing the normal `develop` → `main`
  branching model.
- Treating the admin UI or internal engine modules as stable public APIs.

## Public Compatibility Contract

`v1.0.0` declares these surfaces stable under Semantic Versioning:

1. The documented OpenAI-compatible API.
2. The plugin manifest (`plugin.json`) and the published Plugin SDK contract.
3. Documented configuration, environment variables, and database migration
   behaviour required to upgrade a supported installation.

The admin-panel UX, internal engine modules, non-public database internals, and
undocumented implementation details may evolve without a major version bump.
The README and release notes must state this boundary plainly.

## Sources of Truth

| Concern | Source of truth | Rule |
| --- | --- | --- |
| Product version | Root `package.json` | Canonical `X.Y.Z` value. |
| Workspace versions | Root, engine, web, and infra package manifests | Must be synchronized by the release preparation flow and checked in CI. |
| Public history | `CHANGELOG.md` | Curated human-readable history, newest release first. |
| GitHub announcement | `docs/releases/vX.Y.Z.md` prepared in the release PR | Reviewed text is published verbatim as the GitHub Release body. |
| Shipped source | Annotated `vX.Y.Z` tag on the merged `main` SHA | A tag is never moved or recreated. |
| In-product identity | Build-time version plus optional Git SHA | Displayed by the web About page without a backend endpoint. |

## Editorial Process

The release agent writes, rather than merely collects, both public texts. It
uses the range from the previous release tag to the candidate SHA, commit and
PR titles, linked issues, affected files, migrations, public documentation, and
the declared compatibility contract.

The resulting text is intentionally curated rather than a raw commit log:

- `CHANGELOG.md` is short, grouped under Keep a Changelog categories (`Added`,
  `Changed`, `Fixed`, `Security` where relevant), and tells an operator what
  matters when upgrading.
- GitHub release notes are narrative: an opening summary, noteworthy features,
  upgrade/install notes, public-contract statement, links, and a full-changelog
  comparison. They may link to the changelog but must not duplicate every line.
- A human maintainer reviews and may edit both drafts in the release PR. Neither
  text is tagged or published until that review is complete.

For `v1.0.0`, the release note starts with a general description of Polyant as
an open-source platform for building and operating customizable AI assistants.
It then introduces the product through its major capabilities: the multi-agent
supervisor, long-term memory, multi-channel delivery, provider-agnostic gateway,
plugins and skills, multi-instance administration, encrypted secrets, Room
automation, and observability. The changelog records a concise feature-oriented
initial release rather than the complete pre-1.0 commit history.

## 1.0.0 Release Flow

### 1. Cut and reconcile

1. Announce a temporary release cut-off on `develop`.
2. Fetch `origin` and inspect branch divergence.
3. Because `main` is not necessarily an ancestor of `develop`, first reconcile
   `main` into `develop` in a dedicated PR or explicit reviewed step. Retain
   every non-conflicting `main` change; for each actual conflict retain the
   `develop` version, as requested for this promotion.
4. Run the full validation suite on the reconciliation result.

This avoids a destructive overwrite of `main` while preserving the rule that
`develop` wins when the two branches conflict.

### 2. Prepare the release on `develop`

1. Select `1.0.0` as the requested version.
2. Generate the changelog and `docs/releases/v1.0.0.md` from the actual change
   range. Move the accepted material from `Unreleased` to
   `## [1.0.0] - YYYY-MM-DD`, leaving a fresh empty `Unreleased` section.
3. Synchronize package versions and lockfiles.
4. Add the About page and build-time version display.
5. Update the README with a public-release introduction, compatibility policy,
   release/changelog links, and upgrade guidance.
6. Run lint, typecheck, unit tests, integration tests with PostgreSQL, build,
   migration check, and a documented smoke test.
7. Open a release-preparation PR into `develop`. Human review approves wording,
   behaviour, and the final candidate scope.

### 3. Promote `develop` to `main`

1. Open the official promotion PR `develop` → `main` after the preparation PR
   has merged and the cut-off is still in effect.
2. Require review plus all configured CI checks. Resolve any remaining conflicts
   by retaining the `develop` version and rerun the full checks on that result.
3. Merge through GitHub. Do not push directly to `main`, force-push either
   protected branch, or replace `main` with a reset.

### 4. Publish from the exact merge commit

1. Verify that local `main` matches `origin/main`, the worktree is clean, the
   requested version is present in all sources of truth, and the candidate SHA
   is the merge commit.
2. Verify successful required checks for that SHA and confirm the reviewed notes
   and changelog match it.
3. Create one immutable annotated tag, `v1.0.0`; sign it when the maintainer has
   a configured signing identity, otherwise create an annotated unsigned tag and
   record that fact. Push only that tag.
4. Create the GitHub Release targeting `v1.0.0` and use the reviewed notes file
   verbatim. It is not a prerelease and includes no manually uploaded assets.
5. Verify that the Release target, tag, `main` SHA, displayed About version, and
   changelog heading agree. GitHub supplies the source ZIP and tarball.

### 5. Close the release

1. Lift the `develop` cut-off and record the release in the project log.
2. Keep `Unreleased` current as work lands for the next release.
3. If a fault is discovered after publication, publish a corrective `1.0.1`;
   never retarget or rewrite `v1.0.0`.

## About Page

The web app gains an authenticated `/about` route. The sidebar footer exposes a
discreet `vX.Y.Z · About` entry; it does not add a prominent primary-navigation
item or a system-settings-only destination.

The page contains:

- A concise Polyant product description.
- Product version and optional build revision, with copy affordance.
- The AGPL-3.0-or-later license and its repository license link.
- Links to Polyant GitHub, the Plugin SDK GitHub repository, `polyant.ai`,
  `docs.polyant.ai`, and the current GitHub Release.
- A clear maintainer attribution: “Maintained by Exelab S.r.l.” linked to
  `https://www.exelab.com/`.

The data is static build metadata, not application state. A test covers route
content and the sidebar link; a version-consistency test protects the displayed
value.

## README and Upgrade Guidance

The README remains the concise entry point. It gains an explicit release/stability
section that links to `CHANGELOG.md`, the GitHub Release, and the About page.
It describes the public compatibility contract without reproducing release notes.

The `v1.0.0` release material gives development-installation upgraders this
minimum sequence: back up PostgreSQL, run `npm ci`, run `npm run db:migrate`,
build the workspace, restart services, and smoke-test authentication plus a
representative chat flow. A fresh install continues to use the existing Quick
Start.

## GitHub and CI Policy

`main` is protected: no direct pushes or force pushes; promotion happens only by
pull request. Required status checks are CI (lint, typecheck, unit, integration,
and build), DCO, and CodeQL; at least one maintainer review is required.

The existing Release Drafter remains a comparison aid. Its draft must be
reconfigured for the manually selected release version and treated as an input
to the agent’s editorial analysis, never as a publishable source of truth.

A release-validation workflow or CI job enforces:

- All synchronized product versions equal the requested release version.
- The changelog contains the dated version heading and leaves `Unreleased` at
  the top.
- The reviewed release-note file exists for the version.
- README and About metadata link to the correct release and license.
- The release tag does not already exist before publication.

## Repository-owned Skills

Four versioned project skills, stored under `.claude/skills/`, make this process
usable by any colleague or agent. They document required inputs, commands,
expected outputs, and explicit confirmation boundaries.

| Skill | Permission boundary | Outcome |
| --- | --- | --- |
| `.claude/skills/release/SKILL.md` | Coordinator; no implicit write permission | Routes an invocation to the correct phase and explains the next gate. |
| `.claude/skills/release-preflight/SKILL.md` | Read-only | Reports branch divergence, change range, public-surface impact, migrations, version drift, CI state, and draft editorial inventory. |
| `.claude/skills/release-prepare/SKILL.md` | May create the release-preparation changes and PR after confirmation | Generates drafts, synchronizes documentation/version/UI changes, validates them, and stops before promotion. |
| `.claude/skills/release-publish/SKILL.md` | Requires explicit version, expected `main` SHA, and confirmation | Revalidates every gate, pushes one tag, creates one GitHub Release, and verifies the result. |

No skill may use a force push, rewrite a tag, bypass branch protection, auto-merge
a PR, or publish merely because a version-like input was supplied. The publish
skill must stop whenever the expected SHA, CI state, version, or note content has
changed since preparation.

## Reference Practices

- [Semantic Versioning 2.0.0](https://semver.org/) defines `1.0.0` as the point
  at which the public API is declared and later compatibility drives version
  changes.
- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) recommends a
  human-oriented, categorized changelog with an `Unreleased` section rather
  than a commit-log dump.
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
  provides source archives for a release tag; [generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
  are useful comparison material but do not replace reviewed editorial notes.
