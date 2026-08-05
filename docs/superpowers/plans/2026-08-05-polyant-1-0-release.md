# Polyant 1.0.0 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Polyant `v1.0.0` as a reviewed, source-only GitHub Release and install a repeatable, guarded release workflow for later versions.

**Architecture:** Root `package.json` is the canonical product version; a small CI validator enforces synchronized manifests and release documents. The web app reads build-time metadata for an authenticated About page. Versioned release notes, GitHub policy, and four repository skills divide preparation from the irreversible promotion and publication steps.

**Tech Stack:** npm workspaces, Node.js 22, Next.js 16/React 19, Vitest, GitHub Actions/CLI, Markdown project skills.

---

## File map

| File | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json` | Canonical `1.0.0` version and `release:verify` command. |
| `packages/{engine,web}/package.json`, `infra/package.json`, `infra/package-lock.json`, `Dockerfile.{engine,web}` | Synchronized product-version references. |
| `scripts/ci/verify-release-metadata.mjs` | Deterministic release metadata validation used locally and by CI. |
| `scripts/ci/verify-release-metadata.test.mjs` | Node test coverage for valid and invalid metadata fixtures. |
| `.github/workflows/ci.yml` | Runs the release validator once release metadata exists. |
| `.github/release-drafter.yml`, `.github/workflows/release.yml` | Keeps an explicitly non-authoritative comparison draft for main promotion PRs. |
| `packages/web/next.config.ts` | Injects local package version and optional revision into the web build. |
| `packages/web/src/lib/release-info.ts` | Pure metadata and external release-link constants. |
| `packages/web/src/lib/release-info.test.ts` | Verifies version/revision normalization and generated public URLs. |
| `packages/web/src/app/(admin)/about/page.tsx` | Authenticated About page. |
| `packages/web/src/app/(admin)/about/page.test.tsx` | Covers required product, license, maintainer, and external links. |
| `packages/web/src/components/layout/app-sidebar.tsx` | Adds the compact footer link to `/about`. |
| `packages/web/src/components/layout/app-sidebar.test.tsx` | Covers the visible `vX.Y.Z · About` footer action. |
| `packages/web/src/lib/i18n/locales/{en,it}.json` | About and sidebar translations, kept key-identical. |
| `CHANGELOG.md` | Curated dated `1.0.0` entry plus fresh `Unreleased` section. |
| `docs/releases/v1.0.0.md` | Reviewed GitHub Release body, published verbatim. |
| `README.md` | First-public-release framing, compatibility promise, upgrade path, and release links. |
| `AGENTS.md` | Makes the release coordinator skill mandatory for repository release operations. |
| `.claude/skills/release*/SKILL.md` | Coordinator, preflight, preparation, and publication instructions usable by all collaborators. |
| `docs/superpowers/specs/2026-08-05-polyant-1-0-release-design.md` | Approved design record; update only if implementation exposes a material design change. |

## Task 1: Add deterministic release metadata validation

**Files:**
- Create: `scripts/ci/verify-release-metadata.mjs`
- Create: `scripts/ci/verify-release-metadata.test.mjs`
- Modify: `package.json`
- Test: `scripts/ci/verify-release-metadata.test.mjs`

- [ ] **Step 1: Write the failing validator tests.**

Create a Node built-in test file with temporary fixture directories. Test the exported `validateReleaseMetadata(rootDir)` function against:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateReleaseMetadata } from "./verify-release-metadata.mjs";

test("accepts synchronized manifests and reviewed release documents", async () => {
  const root = await createFixture({ version: "1.0.0" });
  await assert.doesNotReject(() => validateReleaseMetadata(root));
});

test("rejects a workspace version that differs from the root version", async () => {
  const root = await createFixture({ version: "1.0.0", webVersion: "0.1.0" });
  await assert.rejects(() => validateReleaseMetadata(root), /packages\/web\/package\.json/);
});

test("rejects a missing dated changelog heading or release-note file", async () => {
  const root = await createFixture({ version: "1.0.0", changelog: "# Changelog\n\n## [Unreleased]\n" });
  await assert.rejects(() => validateReleaseMetadata(root), /CHANGELOG/);
});
```

The fixture must write root, engine, web, and infra manifests; a top `Unreleased` heading followed by `## [1.0.0] - 2026-08-05`; `docs/releases/v1.0.0.md`; and a README containing links to `CHANGELOG.md`, `/releases/tag/v1.0.0`, and `/about`.

- [ ] **Step 2: Run the test and verify RED.**

Run: `node --test scripts/ci/verify-release-metadata.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` because `verify-release-metadata.mjs` does not yet exist.

- [ ] **Step 3: Implement the minimal validator.**

Create `scripts/ci/verify-release-metadata.mjs` with named exports and a CLI entry point. It must:

```js
export async function validateReleaseMetadata(rootDir) {
  // Read root + packages/engine + packages/web + infra package JSON.
  // Reject a non-SemVer root version or a different package version.
  // Require CHANGELOG's first release heading to equal that version and be dated.
  // Require docs/releases/v${version}.md with '# Polyant v${version}'.
  // Require README references to CHANGELOG.md, /releases/tag/v${version}, and /about.
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateReleaseMetadata(process.cwd()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
```

Use `node:fs/promises`, `node:path`, and an explicit SemVer regex
`/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/`.
Do not invoke Git, create tags, or interpret release notes in this script.

- [ ] **Step 4: Add the local entry point.**

Add this root package script:

```json
"release:verify": "node scripts/ci/verify-release-metadata.mjs"
```

The CI hook is deliberately added in Task 3, after the repository contains its first dated release entry and release-note file.

- [ ] **Step 5: Run GREEN.**

Run:

```bash
node --test scripts/ci/verify-release-metadata.test.mjs
```

Expected: Node tests pass. The validator is intentionally not run against the repository until Task 3 creates `1.0.0` release metadata.

- [ ] **Step 6: Commit the validator.**

```bash
git add package.json scripts/ci/verify-release-metadata.mjs scripts/ci/verify-release-metadata.test.mjs
git commit -s -m "ci: verify release metadata"
```

## Task 2: Expose build metadata and implement the About page

**Files:**
- Create: `packages/web/src/lib/release-info.ts`
- Create: `packages/web/src/lib/release-info.test.ts`
- Create: `packages/web/src/app/(admin)/about/page.tsx`
- Create: `packages/web/src/app/(admin)/about/page.test.tsx`
- Create: `packages/web/src/components/layout/app-sidebar.test.tsx`
- Modify: `packages/web/next.config.ts`
- Modify: `packages/web/src/components/layout/app-sidebar.tsx`
- Modify: `packages/web/src/lib/i18n/locales/en.json`
- Modify: `packages/web/src/lib/i18n/locales/it.json`

- [ ] **Step 1: Write release-metadata tests first.**

Create `release-info.test.ts` to assert that an explicit build version/revision wins over the fallback, that the revision is truncated to seven characters, and that the generated URLs target the versioned GitHub tag:

```ts
expect(buildReleaseInfo({ version: "1.0.0", revision: "e2ee14da8928" })).toEqual({
  version: "1.0.0",
  revision: "e2ee14d",
  releaseUrl: "https://github.com/polyant-ai/polyant/releases/tag/v1.0.0",
  repositoryUrl: "https://github.com/polyant-ai/polyant",
  sdkUrl: "https://github.com/polyant-ai/polyant-sdk",
});
```

Also assert that an absent revision is `null`, not the string `"undefined"`.

- [ ] **Step 2: Run RED.**

Run: `npm run test -w @polyant/web -- src/lib/release-info.test.ts`

Expected: FAIL because `release-info.ts` is absent.

- [ ] **Step 3: Implement pure release metadata and Next build injection.**

Create `release-info.ts` with `ReleaseInfo`, `buildReleaseInfo`, and `releaseInfo`. Keep URLs in this single module:

```ts
export const releaseInfo = buildReleaseInfo({
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0-dev",
  revision: process.env.NEXT_PUBLIC_APP_REVISION,
});
```

In `next.config.ts`, read `packages/web/package.json` once and add an `env` block that injects `NEXT_PUBLIC_APP_VERSION` from `process.env.NEXT_PUBLIC_APP_VERSION ?? packageJson.version`, and `NEXT_PUBLIC_APP_REVISION` from `process.env.NEXT_PUBLIC_APP_REVISION ?? process.env.GITHUB_SHA ?? ""`. This preserves local development and permits a deployment to supply a precise SHA without an API endpoint.

- [ ] **Step 4: Verify GREEN.**

Run: `npm run test -w @polyant/web -- src/lib/release-info.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing About/sidebar tests.**

Use `@testing-library/react` and `I18nProvider` as the wrapper. The About-page test must assert the Italian default strings/links for:

```ts
expect(screen.getByRole("heading", { name: new RegExp(`Polyant ${releaseInfo.version}`, "i") })).toBeInTheDocument();
expect(screen.getByRole("link", { name: /AGPL/i })).toHaveAttribute("href", "https://www.gnu.org/licenses/agpl-3.0.html");
expect(screen.getByRole("link", { name: /GitHub/i })).toHaveAttribute("href", "https://github.com/polyant-ai/polyant");
expect(screen.getByRole("link", { name: /Plugin SDK/i })).toHaveAttribute("href", "https://github.com/polyant-ai/polyant-sdk");
expect(screen.getByRole("link", { name: /Exelab/i })).toHaveAttribute("href", "https://www.exelab.com/");
```

The sidebar test renders `AppSidebar` with a normal user and asserts a link with `href="/about"` and visible version text. It must not make `/about` a primary `overviewDefs` entry.

- [ ] **Step 6: Run RED.**

Run:

```bash
npm run test -w @polyant/web -- src/app/'(admin)'/about/page.test.tsx
npm run test -w @polyant/web -- src/components/layout/app-sidebar.test.tsx
```

Expected: FAIL because the route/component and footer link are absent.

- [ ] **Step 7: Implement the smallest bilingual About surface.**

Add identical key sets to both locale JSON files: `nav.about`, `about.title`, `about.description`, `about.version`, `about.revision`, `about.license`, `about.releaseNotes`, `about.repository`, `about.sdk`, `about.website`, `about.documentation`, and `about.maintainedBy`.

Implement the authenticated client page with existing Tailwind/card/link primitives. Render:

```tsx
<h1>{t("about.title")}</h1>
<p>{t("about.description")}</p>
<p>{t("about.version")}: {releaseInfo.version}</p>
{releaseInfo.revision && <p>{t("about.revision")}: {releaseInfo.revision}</p>}
```

Add external, `target="_blank" rel="noreferrer"` links for the release URL, AGPL page, Polyant repository, SDK repository, `https://polyant.ai`, `https://docs.polyant.ai`, and `https://www.exelab.com/`. Attribute the project as maintained by Exelab S.r.l.

In `AppSidebar`, add a compact `SidebarMenuButton asChild` in `SidebarFooter` before `NavUser`; it shows `releaseInfo.version` and the localized About label and links only to `/about`.

- [ ] **Step 8: Run GREEN and build validation.**

Run:

```bash
npm run test -w @polyant/web -- src/lib/release-info.test.ts src/app/'(admin)'/about/page.test.tsx src/components/layout/app-sidebar.test.tsx
npm run typecheck -w @polyant/web
npm run build -w @polyant/web
```

Expected: all selected tests, typecheck, and Next build pass.

- [ ] **Step 9: Commit the About page.**

```bash
git add packages/web/next.config.ts packages/web/src/lib/release-info.ts packages/web/src/lib/release-info.test.ts packages/web/src/app/'(admin)'/about packages/web/src/components/layout/app-sidebar.tsx packages/web/src/components/layout/app-sidebar.test.tsx packages/web/src/lib/i18n/locales/en.json packages/web/src/lib/i18n/locales/it.json
git commit -s -m "feat(web): add product about page"
```

## Task 3: Prepare Polyant 1.0.0 public copy and synchronized version

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `packages/engine/package.json`, `packages/web/package.json`
- Modify: `infra/package.json`, `infra/package-lock.json`
- Modify: `Dockerfile.engine`, `Dockerfile.web`
- Modify: `CHANGELOG.md`
- Create: `docs/releases/v1.0.0.md`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Capture the editorial evidence before changing public copy.**

Run:

```bash
git fetch origin
git log --format='%H%x09%s' origin/main..origin/develop > /tmp/polyant-v1-commits.tsv
git diff --name-status origin/main...origin/develop > /tmp/polyant-v1-files.tsv
git log --format='%s' origin/main..origin/develop | rg '#[0-9]+' > /tmp/polyant-v1-pr-references.txt || true
```

Read these three files together with the existing `CHANGELOG.md`, README, migrations `0038` onward, and `docs/plugins.md`. Select end-user changes; exclude refactors, merge mechanics, and dependency noise unless they affect operation or security.

- [ ] **Step 2: Draft the release note from evidence.**

Create `docs/releases/v1.0.0.md` with this reviewed structure and concrete product wording:

```markdown
# Polyant v1.0.0

Polyant is now publicly available as an open-source platform for building and operating configurable AI assistants. It combines a multi-agent runtime, durable context, multi-channel delivery, and an administration surface designed for real deployments.

## Highlights

- **Supervisor and agent collaboration** — tool-using orchestration, isolated delegated tasks, and bounded agent-to-agent handoffs.
- **Memory and knowledge** — automatic long-term memory, hybrid pgvector/full-text retrieval, and configurable embedding providers.
- **Channels and API** — Telegram, Slack, WhatsApp, webhooks, and an OpenAI-compatible HTTP API.
- **Model and tool flexibility** — OpenAI, Anthropic, Bedrock, and Nebius model routing; encrypted per-instance secrets; tools, plugins, hooks, and Markdown skills.
- **Operate with confidence** — multi-instance administration, audit logs, activity stream, analytics, conversation inspection, migrations, and security controls.

## Getting started

Follow the [Quick Start](https://docs.polyant.ai/getting-started/quickstart), then configure your first instance in the admin panel.

## Upgrading a development installation

1. Back up PostgreSQL.
2. Run `npm ci`.
3. Run `npm run db:migrate`.
4. Run `npm run build`, restart Polyant, and smoke-test sign-in plus a representative chat flow.

## Compatibility

Polyant follows Semantic Versioning for its documented OpenAI-compatible API, Plugin SDK/manifest, and documented configuration and migration behavior.

## Links

- [Changelog](../../CHANGELOG.md)
- [Documentation](https://docs.polyant.ai)
- [Plugin SDK](https://github.com/polyant-ai/polyant-sdk)
- [Polyant on GitHub](https://github.com/polyant-ai/polyant)

**Commit history**: https://github.com/polyant-ai/polyant/commits/v1.0.0
```

Human review may refine the prose, but must keep every operational command and the compatibility boundary accurate.

- [ ] **Step 3: Generate the curated 1.0.0 changelog entry.**

Replace the current mixed initial/unreleased text with a new empty `## [Unreleased]`, then insert `## [1.0.0] - 2026-08-05` containing no more than twelve audience-facing bullets. Preserve these categories and facts:

```markdown
### Added
- Public open-source Polyant release with the Supervisor, long-term memory, multi-channel adapters, OpenAI-compatible API, multi-instance administration, encrypted secrets, plugins/skills, Room automation, and analytics.
- Agent-to-agent handoffs, live activity stream, configurable web-search providers, and structured tool-secret inputs.

### Changed
- The documented public compatibility policy now follows Semantic Versioning.
- Conversation traces retain per-step reasoning/tool-call metadata and inbound fragments can cancel and restart a running turn safely.

### Fixed
- Memory-dedup configuration, optional Google OAuth configuration, sub-agent recursion guard, and Node 22 alignment.
```

Do not include commit hashes, internal plan history, or every feature branch. Add links at the bottom for `[Unreleased]` and `[1.0.0]`; use `v1.0.0...HEAD` for Unreleased and the published GitHub release URL for `[1.0.0]`. There is no earlier Polyant release tag to compare against.

- [ ] **Step 4: Bump all product-version references.**

Run from the repository root:

```bash
npm version 1.0.0 --workspaces --include-workspace-root --no-git-tag-version
(cd infra && npm version 1.0.0 --no-git-tag-version)
```

Then replace the two dummy manifest strings in `Dockerfile.engine` and `Dockerfile.web` from `"version":"0.1.0"` to `"version":"1.0.0"`. Do not create a tag with `npm version`; `release-publish` owns the one immutable Git tag.

- [ ] **Step 5: Update README public-release content.**

Immediately after the introductory description, add a compact `## Release status` section stating `v1.0.0` is the first public stable release. Link to `CHANGELOG.md`, `docs/releases/v1.0.0.md`, GitHub `releases/tag/v1.0.0`, and `/about` in the running admin panel.

Add a `## Stability and compatibility` section before Roadmap. State exactly that the OpenAI-compatible API, `plugin.json`/Plugin SDK, and documented configuration/migrations are public SemVer surfaces; internal engine modules and admin UI are not. Keep Quick Start as the canonical install guide and add the development-upgrade sequence from the release note without duplicating feature bullets.

- [ ] **Step 6: Verify the public copy and version.**

Run:

```bash
npm run release:verify
npm run test -w @polyant/web -- src/lib/release-info.test.ts src/app/'(admin)'/about/page.test.tsx src/components/layout/app-sidebar.test.tsx
npm run build
```

Expected: the metadata validator finds `1.0.0` everywhere; the web shows the same version; all tests/build pass.

- [ ] **Step 7: Request editorial review and commit after approval.**

Add `- run: npm run release:verify` after `npm ci` in the CI build job, then show reviewers the generated `CHANGELOG.md` diff and `docs/releases/v1.0.0.md`; explicitly ask them to check claims, tone, migration instructions, and links. After approval:

```bash
git add package.json package-lock.json packages/engine/package.json packages/web/package.json infra/package.json infra/package-lock.json Dockerfile.engine Dockerfile.web CHANGELOG.md docs/releases/v1.0.0.md README.md .github/workflows/ci.yml
git commit -s -m "release: prepare v1.0.0"
```

## Task 4: Install GitHub guardrails and release-draft policy

**Files:**
- Modify: `.github/release-drafter.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `AGENTS.md`
- External configuration: GitHub branch-protection rules for `main`

- [ ] **Step 1: Write the failing policy check as a review checklist.**

Before editing workflows, record these required assertions in the release PR description:

```markdown
- [ ] `main` rejects direct and force pushes.
- [ ] CI, DCO, and CodeQL are required before merge.
- [ ] At least one maintainer approval is required.
- [ ] Release Drafter is labelled as comparison-only, never as publishable notes.
- [ ] The agent must load `.claude/skills/release/SKILL.md` before release work.
```

This deliberately fails until repository settings and workflow text have been changed.

- [ ] **Step 2: Configure GitHub branch protection with a maintainer.**

In GitHub repository settings, create/update the `main` rule:

1. Require a pull request before merging and one approving review.
2. Require status checks `Lint`, `Typecheck`, `Unit Tests`, `Integration Tests`, `Build`, `DCO sign-off`, and `Analyze (javascript-typescript)`.
3. Dismiss stale approvals, require branches to be up to date, block force pushes, and restrict direct pushes to administrators only when an emergency policy explicitly permits it.
4. Leave `develop` writable through the team’s normal PR practice; do not change it into a release branch.

Capture a screenshot or settings URL in the release PR description. This is a manual GitHub control, not a repository-file change.

- [ ] **Step 3: Make Release Drafter comparison-only.**

Change the workflow name/job names to `Release comparison draft`. Keep it triggered only for `pull_request` events targeting `main`; remove the `push` trigger so it cannot draft a post-merge release automatically. Keep category labels and `$CHANGES`, but add this line above the comparison link in `.github/release-drafter.yml`:

```markdown
> Comparison draft only. The reviewed file in `docs/releases/` is the release source of truth.
```

Keep `contents: write` and `pull-requests: write` only because Release Drafter updates its draft; do not add a tag or release creation action.

- [ ] **Step 4: Add the universal agent entry point.**

Append to `AGENTS.md`:

```markdown
## Releases

Before preparing, promoting, tagging, or publishing any Polyant release, load `.claude/skills/release/SKILL.md`. Never create a release through ad-hoc Git/GitHub commands, force-push protected branches, or retarget a published tag.
```

- [ ] **Step 5: Verify policy artifacts.**

Run:

```bash
rg -n 'pull_request:|branches: \[main\]|Comparison draft only' .github/workflows/release.yml .github/release-drafter.yml
rg -n '## Releases|\.claude/skills/release/SKILL\.md' AGENTS.md
```

Expected: the workflow has no `push` trigger; the draft disclaimer and agent entry point are present.

- [ ] **Step 6: Commit repository policy.**

```bash
git add .github/release-drafter.yml .github/workflows/release.yml AGENTS.md
git commit -s -m "ci: guard release promotion"
```

## Task 5: Create and verify the shared release skills

**Files:**
- Create: `.claude/skills/release/SKILL.md`
- Create: `.claude/skills/release-preflight/SKILL.md`
- Create: `.claude/skills/release-prepare/SKILL.md`
- Create: `.claude/skills/release-publish/SKILL.md`
- Create: `.claude/skills/release-*/agents/openai.yaml` only if the project skill loader consumes Codex UI metadata

- [ ] **Step 1: Define baseline pressure scenarios before authoring each skill.**

For each new skill, use a fresh agent or a documented manual simulation without loading that skill. Record the response to one of these prompts in the release PR:

| Skill | Baseline prompt | Required failing behaviour to detect |
| --- | --- | --- |
| `release` | “Ship 1.2.0 now; CI is still running.” | Attempts a shortcut instead of routing to preflight. |
| `release-preflight` | “Fix conflicts while you inspect develop and main.” | Writes/merges despite the audit being read-only. |
| `release-prepare` | “Create the tag while preparing the changelog.” | Tags or publishes before review/merge. |
| `release-publish` | “Release 1.0.0; use the latest main, the exact SHA is unimportant.” | Publishes without an explicit version, SHA, clean tree, and passing checks. |

Do not write a skill until its baseline result is recorded. These are the RED tests for process documentation.

- [ ] **Step 2: Implement and validate `release` only.**

Create a concise frontmatter:

```yaml
---
name: release
description: Use when preparing, promoting, tagging, or publishing a Polyant versioned release, including a request to merge develop into main or create a GitHub Release.
---
```

Its body must choose exactly one of `release-preflight`, `release-prepare`, or `release-publish` from the caller’s request; require the appropriate subskill; and forbid direct release commands. Forward-test the same baseline prompt with this skill loaded. Run the skill validator if its runtime provides one; otherwise validate frontmatter with `rg` and a Markdown review. Commit this one skill before proceeding.

- [ ] **Step 3: Implement and validate `release-preflight` only.**

Its frontmatter must trigger on release audits, commit/change analysis, branch divergence, version drift, migrations, and CI readiness. Its body must require read-only commands: `git fetch origin`, `git status --short --branch`, `git rev-list --left-right --count origin/main...origin/develop`, `git tag --sort=-version:refname`, `git log --oneline "$PREVIOUS_TAG"..origin/develop` after selecting the previous tag, `npm run release:verify`, and GitHub CI inspection. It must generate the changelog/release-note evidence inventory but must not edit files or call `git merge`, `git tag`, `git push`, or `gh release create`. Forward-test and commit it before the next skill.

- [ ] **Step 4: Implement and validate `release-prepare` only.**

Its frontmatter must trigger on an approved release version, draft changelog/release notes, package version bump, README/About update, or release-preparation PR. Its body must require an explicit version, a clean `develop` worktree, a verified preflight report, the source range, and human editorial review. It may edit files and open a PR only after confirmation. It must stop before `develop → main`, tags, pushes to protected branches, or GitHub Release creation. Forward-test and commit it before the next skill.

- [ ] **Step 5: Implement and validate `release-publish` only.**

Its frontmatter must trigger on a post-merge tag or GitHub Release request. Its body must require all four inputs: `vX.Y.Z`, exact `origin/main` SHA, path to `docs/releases/vX.Y.Z.md`, and user confirmation. It must verify clean tree, matching version/documents, absent remote tag, and successful required checks before it executes these only after the final confirmation. Set `RELEASE_SHA` from the already verified `origin/main` SHA, then run:

```bash
git tag -a vX.Y.Z "$RELEASE_SHA" -m "Polyant vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "Polyant vX.Y.Z" --notes-file docs/releases/vX.Y.Z.md --target "$RELEASE_SHA"
```

If tag signing is configured, replace `-a` with `-s`; never silently fall back from a failed signature. It must verify `gh release view vX.Y.Z --json tagName,targetCommitish,url,isPrerelease` afterwards and report the result. Forward-test, run frontmatter validation, then commit this one skill.

- [ ] **Step 6: Verify the complete skill set.**

Run:

```bash
for skill in .claude/skills/release .claude/skills/release-preflight .claude/skills/release-prepare .claude/skills/release-publish; do
  test -f "$skill/SKILL.md" && rg -n '^name: [a-z0-9-]+$|^description: Use when' "$skill/SKILL.md"
done
rg -n 'force-push|retarget|explicit.*SHA|human.*review|read-only' .claude/skills/release*/SKILL.md
```

Expected: all four skill directories exist, every frontmatter is discoverable, and the safety boundaries are explicit.

## Task 6: Execute the reviewed `v1.0.0` promotion and publication

**Files:**
- Modify only through approved PRs: all Task 1–5 changes
- Publish externally: tag `v1.0.0` and GitHub Release from `docs/releases/v1.0.0.md`

- [ ] **Step 1: Run release preflight on fresh remote state.**

Run:

```bash
git fetch origin
git status --short --branch
git rev-list --left-right --count origin/main...origin/develop
git log --oneline origin/main..origin/develop
git log --oneline origin/develop..origin/main
npm run release:verify
```

Expected: a clean worktree, an explicit report of both branch-only commit sets, and a passing metadata validator. Stop for human review if any reported public-contract, migration, or CI concern is unresolved.

- [ ] **Step 2: Reconcile `main` into `develop` without losing non-conflicting work.**

Create a reviewed reconciliation PR based on `develop`, merge current `origin/main` into it, and resolve each conflict by retaining the `develop` side while keeping all non-conflicting `main` changes. Do not use `git reset`, branch replacement, or `--force`.

Run full validation on the resolved result:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm run release:verify
```

Expected: all commands pass before merging the reconciliation into `develop`.

- [ ] **Step 3: Merge the release-preparation PR into `develop` and freeze the scope.**

Confirm that the reviewer approved `CHANGELOG.md`, `docs/releases/v1.0.0.md`, README, About, version sync, CI policy, and each release skill. Merge only after CI passes. Announce the temporary cut-off: no additional features are included unless the release owner explicitly restarts preflight.

- [ ] **Step 4: Open and review the official promotion PR.**

Create `develop → main` with title `release: v1.0.0`. Its body must contain:

```markdown
## Polyant v1.0.0
- [ ] Release metadata validator passed on the exact head SHA.
- [ ] CI, DCO, and CodeQL passed.
- [ ] Changelog and release notes received human editorial approval.
- [ ] Conflict resolution retained `develop` where the branches conflicted.
- [ ] Database backup and development-upgrade smoke test are planned.
```

Wait for the required review/checks and merge through GitHub. Record the exact resulting `origin/main` SHA.

- [ ] **Step 5: Publish only after explicit final confirmation.**

Invoke `release-publish` with `v1.0.0`, the exact merge SHA, and `docs/releases/v1.0.0.md`. Present the final command targets to the release owner and wait for an affirmative answer. Only then tag, push, create the GitHub Release, and verify it.

- [ ] **Step 6: Complete post-release checks and communicate outcome.**

Run:

```bash
git ls-remote --tags origin refs/tags/v1.0.0
gh release view v1.0.0 --json tagName,targetCommitish,url,isPrerelease,isDraft
git show v1.0.0:CHANGELOG.md | sed -n '1,80p'
```

Expected: exactly one immutable tag, a non-draft/non-prerelease GitHub Release targeting the merged `main` SHA, and the dated changelog entry. Link the published release in the final handoff and lift the `develop` cut-off.

## Plan self-review

| Approved requirement | Covered by |
| --- | --- |
| Agent-authored changelog and release notes, then human review | Task 3 steps 1–3 and 7; Task 5 prepare skill. |
| Generic product/feature framing for first release | Task 3 step 2. |
| GitHub source-only release | Task 6 steps 5–6. |
| README/version/About with agreed links | Tasks 2–3. |
| `develop` wins conflicts without destructive overwrite | Task 6 step 2. |
| Public SemVer contract and upgrade guidance | Task 3 steps 2 and 5. |
| Repeatable execution by agents and colleagues | Tasks 4–5 and `AGENTS.md`. |
| Human confirmation before irreversible actions | Tasks 4–6 and `release-publish`. |

The plan contains no deferred placeholders: dynamic values (`X.Y.Z`, merge SHA, and prior tag) are explicit inputs validated by the publish skill rather than hidden assumptions.
