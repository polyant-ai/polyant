// ---------------------------------------------------------------------------
// release:prepare — write every mechanical mirror of a release version
// ---------------------------------------------------------------------------
//
// A release version is stated in the root manifest, its lockfile entries, the
// CHANGELOG heading and the release-note filename and H1 — nowhere else, so a
// release diff stays small enough to read. `release:verify` refuses a release
// where those disagree; this is the half that WRITES them, so agreeing is the
// default rather than the reward for remembering a list.
//
// It deliberately stops at the prose. The heading, the file and the paragraph
// are created; what a release actually changed is written by a human (or by an
// agent following `.claude/skills/release/SKILL.md`), because that is the part where a
// claim can be false, and a false claim in a changelog is worse than a missing
// one.
//
// Every function below takes an explicit `rootDir` so the whole thing is
// testable against a fixture directory, with no repository and no git.

import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

import { releaseFacts, releaseNoteHeading, isValidReleaseVersion } from "./release-facts.mjs";

const read = (rootDir, rel) => readFile(path.join(rootDir, rel), "utf8");
const write = (rootDir, rel, contents) => writeFile(path.join(rootDir, rel), contents);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Escape a version for use inside a RegExp — dots are the whole point of a version. */
function quote(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Versions: manifests
// ---------------------------------------------------------------------------

/**
 * Set `version` in every versioned manifest, and return the files rewritten.
 *
 * The manifests are edited textually rather than through `JSON.parse` +
 * `stringify`: a reserialise reformats the whole file, so the diff of a version
 * bump would be the entire manifest and a review could not see what changed.
 */
export async function applyVersion(rootDir, version, facts = releaseFacts) {
  if (!isValidReleaseVersion(version)) {
    throw new Error(`"${version}" is not a release version (expected plain SemVer, such as 1.2.0).`);
  }

  const changed = [];

  for (const manifest of facts.manifests) {
    const before = await read(rootDir, manifest);
    const after = before.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`);
    if (!/"version":\s*"[^"]*"/.test(before)) {
      throw new Error(`${manifest} declares no "version" to update.`);
    }
    if (after !== before) await write(rootDir, manifest, after);
    changed.push(manifest);
  }

  return changed;
}

/**
 * Set `version` on the lockfiles' own entries: the file's top level and the root
 * package (workspaces declare no version), and return the lockfiles rewritten.
 *
 * Textual for the same reason as the manifests, and because `npm install
 * --package-lock-only` with whichever npm happens to be installed also rewrites
 * fields it does not know (npm 10 drops the `libc` fields a newer npm wrote), so
 * the release commit would carry lockfile churn that has nothing to do with the
 * version. Dependency entries live under `node_modules/` and are never touched.
 */
export async function applyLockfileVersions(rootDir, version, facts = releaseFacts) {
  const changed = [];
  for (const lockRoot of facts.lockfileRoots) {
    const file = path.posix.join(lockRoot === "." ? "" : lockRoot, "package-lock.json");
    const before = await read(rootDir, file);
    let entries = 0;
    // The top-level name/version pair, two-space indented.
    let after = before.replace(/^(  "version":\s*)"[^"]*"/m, (_, head) => {
      entries += 1;
      return `${head}"${version}"`;
    });
    // `packages` entries that are not dependencies and carry a version: the root "".
    after = after.replace(
      /^(    "(?![^"]*node_modules\/)[^"]*": \{\n      "name": "[^"]*",\n      "version": )"[^"]*"/gm,
      (_, head) => {
        entries += 1;
        return `${head}"${version}"`;
      },
    );
    if (entries < 2) throw new Error(`${file} has no workspace entries with a version to update.`);
    if (after !== before) await write(rootDir, file, after);
    changed.push(file);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

const CHANGELOG = "CHANGELOG.md";
const UNRELEASED = "## [Unreleased]";

/** The version of the most recent dated release already in the file, if any. */
export function previousChangelogVersion(changelog) {
  const match = changelog.match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/m);
  return match ? match[1] : null;
}

/**
 * Rewrite the link-reference block at the tail, PRESERVING the shape the file
 * already uses. A changelog may compare release to release or point at the
 * tag, and a release should not silently migrate the file from one to the other.
 */
function updateLinkReferences(changelog, version, previous, repositoryUrl) {
  const comparesReleases = new RegExp(`^\\[${quote(previous ?? "")}\\]: \\S+/compare/`, "m").test(changelog);
  const newEntry =
    previous && comparesReleases
      ? `[${version}]: ${repositoryUrl}/compare/v${previous}...v${version}`
      : `[${version}]: ${repositoryUrl}/releases/tag/v${version}`;

  let updated = changelog.replace(
    /^\[Unreleased\]: \S+$/m,
    `[Unreleased]: ${repositoryUrl}/compare/v${version}...HEAD`,
  );
  if (updated === changelog && !/^\[Unreleased\]:/m.test(changelog)) return changelog;

  return updated.replace(/^(\[Unreleased\]: \S+)$/m, `$1\n${newEntry}`);
}

/**
 * Move the content of `## [Unreleased]` under a new `## [version] - date`
 * heading, leaving Unreleased empty above it. An Unreleased section with no
 * entries gets the Keep a Changelog subsections left empty for a human to fill.
 */
export async function ensureChangelogSection(rootDir, version, date, facts = releaseFacts) {
  const changelog = await read(rootDir, CHANGELOG);

  if (new RegExp(`^## \\[${quote(version)}\\]`, "m").test(changelog)) {
    throw new Error(`${CHANGELOG} already carries a section for ${version}.`);
  }
  const start = changelog.indexOf(`${UNRELEASED}\n`);
  if (start === -1) {
    throw new Error(`${CHANGELOG} has no "${UNRELEASED}" heading to insert under.`);
  }

  const previous = previousChangelogVersion(changelog);
  const bodyStart = start + UNRELEASED.length + 1;
  // The Unreleased body runs to the next release heading or to the link references.
  const rest = changelog.slice(bodyStart);
  const end = rest.search(/^(?:## \[|\[[^\]]+\]: )/m);
  const body = (end === -1 ? rest : rest.slice(0, end)).trim();
  const tail = end === -1 ? "" : rest.slice(end);

  const content = body === "" ? ["### Added", "", "### Changed", "", "### Fixed"].join("\n") : body;
  const withSection = `${changelog.slice(0, bodyStart)}\n## [${version}] - ${date}\n\n${content}\n\n${tail}`;
  await write(rootDir, CHANGELOG, updateLinkReferences(withSection, version, previous, facts.repositoryUrl));
  return previous;
}

// ---------------------------------------------------------------------------
// Release note
// ---------------------------------------------------------------------------

/**
 * Create `docs/releases/v<version>.md` carrying the exact H1 the verifier
 * compares byte for byte. An existing file is left alone: by the time this runs
 * a second time, somebody has written the notes.
 */
export async function ensureReleaseNote(rootDir, version, facts = releaseFacts) {
  const relativePath = path.posix.join("docs", "releases", `v${version}.md`);
  if (await exists(path.join(rootDir, relativePath))) return { path: relativePath, created: false };

  const body = [
    releaseNoteHeading(version, facts),
    "",
    `TODO: what this release is for, in a paragraph. Highlights, breaking changes and`,
    `security below. Written from the commits, and every claim checked against the`,
    `previous release rather than copied from another build's notes.`,
    "",
    "## Highlights",
    "",
    "## Breaking changes",
    "",
    "## Security",
    "",
  ].join("\n");

  await write(rootDir, relativePath, body);
  return { path: relativePath, created: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * The files this command owns. The working tree may be dirty in them (a rerun,
 * or a hand edit to the notes) and must be clean everywhere else: a release
 * commit that also sweeps up somebody's unrelated work in progress is how a
 * release stops being reviewable — and on a shared checkout that work in
 * progress may not even be yours.
 */
export function ownedPaths(version, facts = releaseFacts) {
  return new Set([
    ...facts.manifests,
    ...facts.lockfileRoots.map((root) => path.posix.join(root === "." ? "" : root, "package-lock.json")),
    "CHANGELOG.md",
    path.posix.join("docs", "releases", `v${version}.md`),
  ]);
}

async function shell(command, args, options = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)(command, args, { maxBuffer: 32 * 1024 * 1024, ...options });
}

/**
 * The tracked, modified paths that this command does not own.
 *
 * Untracked files are deliberately ignored: they cannot reach a commit unless
 * somebody adds them by name, and refusing on them makes the command unusable
 * in a checkout that has scratch files lying around — which is every checkout.
 */
export function foreignChanges(porcelain, owned) {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter((file) => !owned.has(file));
}

async function assertTreeCleanOutsideOwned(rootDir, version, facts) {
  let porcelain;
  try {
    ({ stdout: porcelain } = await shell("git", ["status", "--porcelain"], { cwd: rootDir }));
  } catch {
    return; // not a repository: nothing to protect
  }
  const foreign = foreignChanges(porcelain, ownedPaths(version, facts));

  if (foreign.length > 0) {
    throw new Error(
      `the working tree carries changes this command does not own:\n  ${foreign.join("\n  ")}\n` +
        "Commit or stash them first — a release commit must not carry them.",
    );
  }
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: npm run release:prepare <version>");
    process.exitCode = 1;
    return;
  }

  const rootDir = process.cwd();
  const facts = releaseFacts;
  const date = process.argv[3] ?? new Date().toISOString().slice(0, 10);

  await assertTreeCleanOutsideOwned(rootDir, version, facts);

  const changed = await applyVersion(rootDir, version, facts);
  console.log(`versions   ${version} in ${changed.length} file(s)`);

  const locks = await applyLockfileVersions(rootDir, version, facts);
  console.log(`lockfiles  ${version} in ${locks.join(", ")}`);

  await ensureChangelogSection(rootDir, version, date, facts);
  console.log(`changelog  ## [${version}] - ${date} added from Unreleased`);

  const note = await ensureReleaseNote(rootDir, version, facts);
  console.log(`notes      ${note.path} ${note.created ? "created" : "left alone (already written)"}`);

  const { validateReleaseMetadata } = await import("../ci/verify-release-metadata.mjs");
  await validateReleaseMetadata(rootDir);
  console.log("verify     release metadata consistent");

  console.log(
    `\nWhat is left is the prose: the ${version} section of CHANGELOG.md and ${note.path}.\n` +
      "Write it from the commits, and check every claim against the previous release —\n" +
      "a changelog inherited from another build states things that were never true here.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
