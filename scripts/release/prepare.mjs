// ---------------------------------------------------------------------------
// release:prepare — write every mechanical mirror of a release version
// ---------------------------------------------------------------------------
//
// A release version is restated in a surprising number of places: four
// manifests, two lockfiles, three Docker stubs, the generated engine metadata,
// the CHANGELOG heading, the release-note filename and its H1, and the README
// paragraph. `release:verify` already refuses a release where those disagree —
// this is the half that WRITES them, so agreeing is the default rather than the
// reward for remembering a list.
//
// It deliberately stops at the prose. The heading, the file and the paragraph
// are created; what a release actually changed is written by a human (or by an
// agent following the release-prepare skill), because that is the part where a
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
// Versions: manifests + Docker stubs
// ---------------------------------------------------------------------------

/**
 * Set `version` in every manifest and in every Docker stub, and return the
 * files actually rewritten.
 *
 * The manifests are edited textually rather than through `JSON.parse` +
 * `stringify`: a reserialise reformats the whole file, so the diff of a version
 * bump would be the entire manifest and a review could not see what changed.
 */
export async function applyVersion(rootDir, version, facts = releaseFacts) {
  if (!isValidReleaseVersion(version, facts)) {
    throw new Error(`"${version}" is not a release version for this build (expected SemVer${facts.versionSuffix ? ` ending in ${facts.versionSuffix}` : ""}).`);
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

  for (const stub of facts.dockerStubs) {
    const before = await read(rootDir, stub.file);
    // Anchored on the package name: a stub restates the OTHER workspace's
    // manifest, and both stages of a multi-stage build carry the same line.
    const pattern = new RegExp(`("name":"${quote(stub.package)}","version":")[^"]*(")`, "g");
    if (!pattern.test(before)) {
      throw new Error(`${stub.file} carries no stub for ${stub.package}.`);
    }
    pattern.lastIndex = 0;
    const after = before.replace(pattern, `$1${version}$2`);
    if (after !== before) await write(rootDir, stub.file, after);
    changed.push(stub.file);
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
 * already uses. The two builds settled on different conventions — one compares
 * release to release, the other points at the tag — and a release should not
 * silently migrate its repository from one to the other.
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
 * Insert `## [version] - date` directly under `## [Unreleased]`, with the
 * Keep a Changelog subsections left empty for a human to fill.
 */
export async function ensureChangelogSection(rootDir, version, date, facts = releaseFacts) {
  const changelog = await read(rootDir, CHANGELOG);

  if (new RegExp(`^## \\[${quote(version)}\\]`, "m").test(changelog)) {
    throw new Error(`${CHANGELOG} already carries a section for ${version}.`);
  }
  if (!changelog.includes(UNRELEASED)) {
    throw new Error(`${CHANGELOG} has no "${UNRELEASED}" heading to insert under.`);
  }

  const previous = previousChangelogVersion(changelog);
  const section = [
    UNRELEASED,
    "",
    `## [${version}] - ${date}`,
    "",
    "### Added",
    "",
    "### Changed",
    "",
    "### Fixed",
    "",
  ].join("\n");

  const withSection = changelog.replace(`${UNRELEASED}\n`, `${section}`);
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
// README
// ---------------------------------------------------------------------------

/**
 * Point the README's release paragraph at the new version.
 *
 * Scoped to the lines that carry a release POINTER (`/releases/tag/v…` or
 * `docs/releases/v…`) and their paragraph, never the whole file: a README also
 * discusses older versions in prose ("upgrading from 1.0.0"), and rewriting
 * those would turn a version bump into a false statement.
 */
export async function retargetReadmeRelease(rootDir, previousVersion, version) {
  const readme = await read(rootDir, "README.md");
  const paragraphs = readme.split(/\n\n/);
  let touched = false;

  const updated = paragraphs.map((paragraph) => {
    if (!/\/releases\/tag\/v|docs\/releases\/v/.test(paragraph)) return paragraph;
    touched = true;
    return paragraph.replaceAll(`v${previousVersion}`, `v${version}`);
  });

  if (!touched) {
    throw new Error("README.md has no release paragraph (no /releases/tag/v… or docs/releases/v… link).");
  }

  await write(rootDir, "README.md", updated.join("\n\n"));
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
    ...facts.dockerStubs.map((stub) => stub.file),
    "CHANGELOG.md",
    "README.md",
    path.posix.join("docs", "releases", `v${version}.md`),
    ...(facts.generatedArtefacts?.files ?? []),
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

/**
 * Regenerate the engine's API contract artefacts, which restate the engine
 * version. They need the three variables `config.ts` refuses to boot without;
 * throwaway values are enough because nothing here touches a database, and the
 * repository's own `.env` cannot be used — it holds secret-manager references,
 * not values.
 */
async function regenerateApiArtefacts(rootDir, facts) {
  if (!facts.generatedArtefacts) return false;
  await shell("npm", ["run", facts.generatedArtefacts.script, "-w", facts.engineWorkspace], {
    cwd: rootDir,
    env: {
      ...process.env,
      ENCRYPTION_KEY: "0".repeat(64),
      AUTH_SECRET: "release-prepare-placeholder-secret-32chars",
      POSTGRES_PASSWORD: "release-prepare",
    },
  });
  return true;
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

  const previous = JSON.parse(await read(rootDir, "package.json")).version;
  const changed = await applyVersion(rootDir, version, facts);
  console.log(`versions   ${version} in ${changed.length} file(s)`);

  for (const root of facts.lockfileRoots) {
    await shell("npm", ["install", "--package-lock-only"], { cwd: path.join(rootDir, root) });
  }
  console.log(`lockfiles  synced (${facts.lockfileRoots.join(", ")})`);

  await ensureChangelogSection(rootDir, version, date, facts);
  console.log(`changelog  ## [${version}] - ${date} added, with empty subsections to fill`);

  const note = await ensureReleaseNote(rootDir, version, facts);
  console.log(`notes      ${note.path} ${note.created ? "created" : "left alone (already written)"}`);

  await retargetReadmeRelease(rootDir, previous, version);
  console.log(`readme     release paragraph points at v${version}`);

  const regenerated = await regenerateApiArtefacts(rootDir, facts);
  console.log(
    regenerated
      ? `artefacts  ${facts.generatedArtefacts.files.join(" + ")} regenerated`
      : "artefacts  none for this build",
  );

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
