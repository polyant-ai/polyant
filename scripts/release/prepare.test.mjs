import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { releaseFacts, releaseNoteHeading, isValidReleaseVersion } from "./release-facts.mjs";
import {
  foreignChanges,
  ownedPaths,
  applyVersion,
  applyLockfileVersions,
  ensureChangelogSection,
  ensureReleaseNote,
} from "./prepare.mjs";
import { validateReleaseMetadata } from "../ci/verify-release-metadata.mjs";

// Package names and the repository come from the facts, so the fixture follows
// them when they change instead of testing a stale copy.
const OLD = "1.1.0";
const NEW = "1.2.0";
const STALE = "1.0.0";

/** A repository shaped like this one, at OLD: the version only in the root
 *  manifest and its lockfile entries, the workspaces declaring none. */
async function writeFixture(rootDir) {
  const json = async (rel, contents) => {
    await mkdir(path.dirname(path.join(rootDir, rel)), { recursive: true });
    await writeFile(path.join(rootDir, rel), `${JSON.stringify(contents, null, 2)}\n`);
  };
  await json("package.json", { name: "polyant", version: OLD, scripts: { build: "x" } });
  await json("packages/engine/package.json", { name: releaseFacts.engineWorkspace });
  await json("packages/web/package.json", { name: "web" });
  await json("infra/package.json", { name: "polyant-infra" });

  // The lockfile as npm writes it: the version on the file and on the root package,
  // none on the workspaces, plus a dependency entry at the same version as the
  // release and carrying a `libc` field the local npm would drop.
  const dependency = {
    "node_modules/left-pad": { version: OLD, resolved: "https://registry.example/left-pad.tgz", libc: ["glibc"] },
  };
  await json("package-lock.json", {
    name: "polyant",
    version: OLD,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "polyant", version: OLD, workspaces: ["packages/*"] },
      ...dependency,
      "node_modules/@polyant/engine": { resolved: "packages/engine", link: true },
      "packages/engine": { name: releaseFacts.engineWorkspace },
      "packages/web": { name: "web" },
    },
  });

  await writeFile(
    path.join(rootDir, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "",
      "- A pending feature.",
      "",
      "### Fixed",
      "",
      "- A pending fix.",
      "",
      `## [${OLD}] - 2026-08-25`,
      "",
      "### Added",
      "",
      "- A thing.",
      "",
      `[Unreleased]: ${releaseFacts.repositoryUrl}/compare/v${OLD}...HEAD`,
      `[${OLD}]: ${releaseFacts.repositoryUrl}/compare/v${STALE}...v${OLD}`,
      "",
    ].join("\n"),
  );

  await mkdir(path.join(rootDir, "docs/releases"), { recursive: true });
  await writeFile(path.join(rootDir, `docs/releases/v${OLD}.md`), `${releaseNoteHeading(OLD)}\n\nNotes.\n`);

  await writeFile(
    path.join(rootDir, "README.md"),
    [
      "# Polyant",
      "",
      `The current release is on the [GitHub releases page](${releaseFacts.repositoryUrl}/releases/latest),`,
      "with the [changelog](CHANGELOG.md). In a running admin installation, details are at [/about](/about).",
      "",
    ].join("\n"),
  );
}

async function withFixture(callback) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "polyant-release-prepare-"));
  try {
    await writeFixture(rootDir);
    await callback(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

/** Versions carry dots: quote before regexing. */
const quote = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const read = (rootDir, rel) => readFile(path.join(rootDir, rel), "utf8");
const readJson = async (rootDir, rel) => JSON.parse(await read(rootDir, rel));

test("isValidReleaseVersion accepts plain SemVer only", () => {
  assert.equal(isValidReleaseVersion("1.2.0"), true);
  assert.equal(isValidReleaseVersion("1.2.0-rc.1"), false, "a prerelease is not a release");
  assert.equal(isValidReleaseVersion("v1.2.0"), false, "the tag prefix is not part of the version");
  assert.equal(isValidReleaseVersion("1.2"), false);
});

test("releaseNoteHeading names the product", () => {
  assert.equal(releaseNoteHeading("1.2.0", { ...releaseFacts, productName: "Polyant" }), "# Polyant v1.2.0");
});

test("applyVersion rewrites the root manifest and leaves the workspaces without a version", async () => {
  await withFixture(async (rootDir) => {
    const changed = await applyVersion(rootDir, NEW, releaseFacts);

    assert.deepEqual(changed, ["package.json"]);
    assert.equal((await readJson(rootDir, "package.json")).version, NEW);
    for (const manifest of releaseFacts.unversionedManifests) {
      assert.equal("version" in (await readJson(rootDir, manifest)), false, manifest);
    }
  });
});

test("applyVersion leaves everything it does not own untouched, and is idempotent", async () => {
  await withFixture(async (rootDir) => {
    await applyVersion(rootDir, NEW, releaseFacts);
    const first = await read(rootDir, "package.json");
    assert.match(first, /"build": "x"/, "sibling manifest keys survive");

    await applyVersion(rootDir, NEW, releaseFacts);
    assert.equal(await read(rootDir, "package.json"), first, "a second run changes nothing");
  });
});

test("applyLockfileVersions bumps the file and the root package, and nothing else", async () => {
  await withFixture(async (rootDir) => {
    const before = await read(rootDir, "package-lock.json");
    const changed = await applyLockfileVersions(rootDir, NEW, releaseFacts);
    assert.deepEqual(changed, ["package-lock.json"]);

    const lock = await readJson(rootDir, "package-lock.json");
    assert.equal(lock.version, NEW);
    assert.equal(lock.packages[""].version, NEW);
    assert.equal("version" in lock.packages["packages/engine"], false, "a workspace gains no version");
    assert.equal(lock.packages["node_modules/left-pad"].version, OLD, "a dependency that shares the version is not ours");
    assert.deepEqual(lock.packages["node_modules/left-pad"].libc, ["glibc"], "fields npm 10 would drop survive");

    // Only the two version lines differ, so the release commit shows nothing else.
    const after = await read(rootDir, "package-lock.json");
    const diff = before.split("\n").filter((line, i) => line !== after.split("\n")[i]);
    assert.equal(diff.length, 2);
    assert.ok(diff.every((line) => line.includes(`"version": "${OLD}"`)));

    await applyLockfileVersions(rootDir, NEW, releaseFacts);
    assert.equal(await read(rootDir, "package-lock.json"), after, "a second run changes nothing");
  });
});

test("applyLockfileVersions refuses a lockfile with no workspace entries to update", async () => {
  await withFixture(async (rootDir) => {
    await writeFile(path.join(rootDir, "package-lock.json"), "{}\n");
    await assert.rejects(() => applyLockfileVersions(rootDir, NEW, releaseFacts), /package-lock\.json/);
  });
});

test("ensureChangelogSection moves the Unreleased entries under the dated heading and leaves Unreleased empty", async () => {
  await withFixture(async (rootDir) => {
    await ensureChangelogSection(rootDir, NEW, "2026-09-01");
    const changelog = await read(rootDir, "CHANGELOG.md");

    const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\S+))?$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, ["Unreleased", NEW, OLD], "newest release first, Unreleased on top");
    assert.match(
      changelog,
      new RegExp(
        `## \\[Unreleased\\]\\n\\n## \\[${quote(NEW)}\\] - 2026-09-01\\n\\n### Added\\n\\n- A pending feature\\.\\n\\n### Fixed\\n\\n- A pending fix\\.\\n\\n## \\[${quote(OLD)}\\]`,
      ),
    );
    assert.equal((changelog.match(/^### Added$/gm) ?? []).length, 2, "one Added per release, none left over in Unreleased");
  });
});

test("ensureChangelogSection gives an empty Unreleased the empty subsections to fill", async () => {
  await withFixture(async (rootDir) => {
    const bare = (await read(rootDir, "CHANGELOG.md")).replace(/(## \[Unreleased\]\n\n)[\s\S]*?(## \[1\.1\.0\])/, "$1$2");
    await writeFile(path.join(rootDir, "CHANGELOG.md"), bare);
    await ensureChangelogSection(rootDir, NEW, "2026-09-01");
    assert.match(
      await read(rootDir, "CHANGELOG.md"),
      new RegExp(`## \\[${quote(NEW)}\\] - 2026-09-01\\n\\n### Added\\n\\n### Changed\\n\\n### Fixed\\n\\n## \\[${quote(OLD)}\\]`),
    );
  });
});

test("ensureChangelogSection keeps the link-reference style the file already uses", async () => {
  await withFixture(async (rootDir) => {
    await ensureChangelogSection(rootDir, NEW, "2026-09-01");
    const changelog = await read(rootDir, "CHANGELOG.md");

    assert.match(changelog, new RegExp(`^\\[Unreleased\\]: \\S+/compare/v${quote(NEW)}\\.\\.\\.HEAD$`, "m"));
    // The fixture compares release to release; the new entry must not switch to
    // the releases/tag shape the other build happens to use.
    assert.match(changelog, new RegExp(`^\\[${quote(NEW)}\\]: \\S+/compare/v${quote(OLD)}\\.\\.\\.v${quote(NEW)}$`, "m"));
  });
});

test("ensureChangelogSection refuses to touch a version the file already carries", async () => {
  await withFixture(async (rootDir) => {
    const before = await read(rootDir, "CHANGELOG.md");
    await assert.rejects(() => ensureChangelogSection(rootDir, OLD, "2026-09-01"), /already/i);
    assert.equal(await read(rootDir, "CHANGELOG.md"), before);
  });
});

test("ensureReleaseNote writes the exact H1 the verifier demands, and never overwrites", async () => {
  await withFixture(async (rootDir) => {
    await ensureReleaseNote(rootDir, NEW, releaseFacts);
    const note = await read(rootDir, `docs/releases/v${NEW}.md`);
    assert.equal(note.split("\n", 1)[0], releaseNoteHeading(NEW, releaseFacts));

    await writeFile(path.join(rootDir, `docs/releases/v${NEW}.md`), `${releaseNoteHeading(NEW)}\n\nHand-written.\n`);
    await ensureReleaseNote(rootDir, NEW, releaseFacts);
    assert.match(await read(rootDir, `docs/releases/v${NEW}.md`), /Hand-written/);
  });
});

test("after a full prepare the metadata verifier passes", async () => {
  await withFixture(async (rootDir) => {
    await applyVersion(rootDir, NEW, releaseFacts);
    await applyLockfileVersions(rootDir, NEW, releaseFacts);
    await ensureChangelogSection(rootDir, NEW, "2026-09-01");
    await ensureReleaseNote(rootDir, NEW, releaseFacts);

    await validateReleaseMetadata(rootDir);
  });
});

test("the metadata verifier refuses a workspace manifest that declares a version again", async () => {
  await withFixture(async (rootDir) => {
    await applyVersion(rootDir, NEW, releaseFacts);
    await ensureChangelogSection(rootDir, NEW, "2026-09-01");
    await ensureReleaseNote(rootDir, NEW, releaseFacts);
    await writeFile(
      path.join(rootDir, "packages/web/package.json"),
      `${JSON.stringify({ name: "web", version: NEW }, null, 2)}\n`,
    );

    await assert.rejects(() => validateReleaseMetadata(rootDir), /packages\/web\/package\.json must not declare a version/);
  });
});

test("foreignChanges reports tracked work in progress, and ignores untracked files", () => {
  const owned = ownedPaths(NEW, releaseFacts);
  const porcelain = [
    " M package.json",                    // owned: a bump in progress
    "M  CHANGELOG.md",                    // owned, staged
    " M packages/engine/src/pipeline.ts", // NOT owned: somebody's work in progress
    "?? scripts/release/",                // untracked: cannot reach a commit unless added
    "?? notes.txt",
    "",
  ].join("\n");

  assert.deepEqual(foreignChanges(porcelain, owned), ["packages/engine/src/pipeline.ts"]);
});

test("ownedPaths covers every mirror the command writes", () => {
  const owned = ownedPaths(NEW, releaseFacts);
  for (const manifest of releaseFacts.manifests) assert.ok(owned.has(manifest), manifest);
  assert.ok(owned.has("package-lock.json"));
  assert.ok(owned.has(`docs/releases/v${NEW}.md`));
});
