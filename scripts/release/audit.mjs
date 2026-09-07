// ---------------------------------------------------------------------------
// release:audit — the evidence a release decision needs, gathered in one place
// ---------------------------------------------------------------------------
//
// Read-only. It changes nothing and answers nothing: it reports what is true
// about this branch against the release branch, and leaves the decision to a
// person.
//
// Every check here exists because it was missed at least once by reading the
// repository by hand:
//   - the working branch declared a version older than the releases already cut
//     from the release branch;
//   - two hotfix CHANGELOG sections shipped from the release branch and never
//     came back on the back-merge, so the changelog skipped from one minor to
//     the next;
//   - a real bug fix lived only on the release branch, because the back-merge
//     that should have carried it never happened.
//
// The pure functions are exported and unit-tested; the git plumbing is in the
// CLI at the bottom, where it can be read for what it assumes.

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { releaseFacts, isValidReleaseVersion } from "./release-facts.mjs";

const run = promisify(execFile);

/** Released (dated) versions in a CHANGELOG, in the order the file lists them. */
export function datedChangelogVersions(changelog) {
  return [...changelog.matchAll(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/gm)].map((match) => match[1]);
}

/** Versions the release branch documents that this branch's CHANGELOG does not. */
export function changelogSectionsMissingHere(here, releaseBranch) {
  const known = new Set(datedChangelogVersions(here));
  return datedChangelogVersions(releaseBranch).filter((version) => !known.has(version));
}

/**
 * Whether the version this branch declares trails the one the release branch
 * carries. Compared as strings, deliberately: the question is "did a release
 * bump fail to come back", and any difference answers it — ordering the two
 * would need a SemVer comparison that the edition suffix makes ambiguous.
 */
export function describeVersionDrift(hereVersion, releaseBranchVersion) {
  if (hereVersion === releaseBranchVersion) {
    return { drifted: false, message: `both branches declare ${hereVersion}` };
  }
  return {
    drifted: true,
    message: `this branch declares ${hereVersion}, the release branch declares ${releaseBranchVersion}`,
  };
}

/**
 * The most recent tag that names a release OF THIS BUILD.
 *
 * Not simply the first of `git tag --sort=-version:refname`: one object store
 * can hold both products' tags (a worktree of one repository checked out from
 * the other's remote is the ordinary case here), and `v1.0.2-ee` sorts above
 * `v1.0.2`. Ranging the changelog against a release this build never cut is a
 * silent wrong answer, so the suffix rule decides membership.
 */
export function selectPreviousReleaseTag(tags, facts = releaseFacts) {
  const mine = tags
    .filter((tag) => tag.startsWith("v"))
    .filter((tag) => isValidReleaseVersion(tag.slice(1), facts));
  return mine[0] ?? null;
}

/**
 * Drop the candidates whose subject already appears on this branch.
 *
 * Patch-id equality is what `git cherry` compares, and a commit that was
 * cherry-picked — or adapted on arrival, which is how ports between these two
 * builds actually happen — arrives with a different patch id and is reported as
 * missing. The subject survives both. It is a weaker signal, so this narrows the
 * list to read rather than deciding anything: what is left still has to be
 * verified by file.
 */
export function dropCommitsAlreadyHereBySubject(candidates, subjectsHere) {
  return candidates.filter((candidate) => !subjectsHere.has(candidate.subject));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function git(args, rootDir) {
  const { stdout } = await run("git", args, { cwd: rootDir, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trimEnd();
}

async function showFromRef(rootDir, ref, filePath) {
  try {
    return await git(["show", `${ref}:${filePath}`], rootDir);
  } catch {
    return null;
  }
}

async function audit(rootDir, releaseRef) {
  const lines = [];
  const say = (line = "") => lines.push(line);

  const hereManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const thereManifestRaw = await showFromRef(rootDir, releaseRef, "package.json");
  if (thereManifestRaw === null) {
    say(`! ${releaseRef} is not reachable — fetch it before trusting anything below.`);
    return lines;
  }
  const thereVersion = JSON.parse(thereManifestRaw).version;

  say(`version   this branch ${hereManifest.version} · ${releaseRef} ${thereVersion}`);
  const drift = describeVersionDrift(hereManifest.version, thereVersion);
  if (drift.drifted) say(`          ! ${drift.message}`);

  const hereChangelog = await readFile(path.join(rootDir, "CHANGELOG.md"), "utf8");
  const thereChangelog = (await showFromRef(rootDir, releaseRef, "CHANGELOG.md")) ?? "";
  const missing = changelogSectionsMissingHere(hereChangelog, thereChangelog);
  say();
  say(
    missing.length === 0
      ? `changelog every version ${releaseRef} documents is documented here too`
      : `changelog ! documented on ${releaseRef}, missing here: ${missing.join(", ")}`,
  );

  // Two filters, both weak on their own. `git cherry` compares patch ids, which
  // a cherry-pick or an adaptation changes; the subject survives that but says
  // nothing about content. Together they narrow the list enough to read.
  const patchIdCandidates = (await git(["cherry", "HEAD", releaseRef], rootDir))
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(2));

  const subjectsHere = new Set(
    (await git(["log", "--format=%s", `${releaseRef}..HEAD`, "--all-match"], rootDir)).split("\n"),
  );
  const described = [];
  for (const sha of patchIdCandidates) {
    described.push({ sha, subject: await git(["log", "-1", "--format=%s", sha], rootDir) });
  }
  const unported = dropCommitsAlreadyHereBySubject(described, subjectsHere);

  say();
  if (unported.length === 0) {
    say(`back-merge nothing on ${releaseRef} is unaccounted for here`);
    if (patchIdCandidates.length > 0) {
      say(`          (${patchIdCandidates.length} differ by patch id — ported with a changed patch, subject matched)`);
    }
  } else {
    say(`back-merge ${unported.length} commit(s) on ${releaseRef} with no equivalent here — CANDIDATES.`);
    say("          Neither patch id nor subject proves absence: verify by file before porting.");
    for (const commit of unported.slice(0, 15)) {
      say(`            ${commit.sha.slice(0, 9)} ${commit.subject}`);
    }
    if (unported.length > 15) say(`            … and ${unported.length - 15} more`);
  }

  const previousTag = selectPreviousReleaseTag(
    (await git(["tag", "--list", "v*", "--sort=-version:refname"], rootDir)).split("\n").filter(Boolean),
  );
  say();
  if (previousTag) {
    const count = await git(["rev-list", "--count", "--no-merges", `${previousTag}..HEAD`], rootDir);
    say(`range     ${count} commit(s) since ${previousTag} — the material for the changelog`);
    say(`          git log --oneline --no-merges ${previousTag}..HEAD`);
  } else {
    say("range     no previous release tag for this build");
  }

  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const releaseRef = process.argv[2] ?? "origin/main";
  audit(process.cwd(), releaseRef)
    .then((lines) => console.log(lines.join("\n")))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
