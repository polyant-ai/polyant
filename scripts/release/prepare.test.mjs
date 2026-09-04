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
  ensureChangelogSection,
  ensureReleaseNote,
  retargetReadmeRelease,
} from "./prepare.mjs";
import { validateReleaseMetadata } from "../ci/verify-release-metadata.mjs";

// Versions and package names come from the facts, never from literals: this
// file is shared verbatim between the two builds, whose releases differ in both
// (`1.2.0` vs `1.2.0-ee`, `@polyant/*` vs `@polyant-enterprise/*`). A hardcoded
// fixture would pass on one build and fail on the other for reasons that have
// nothing to do with the code under test.
const suffix = releaseFacts.versionSuffix ?? "";
const OLD = `1.1.0${suffix}`;
const NEW = `1.2.0${suffix}`;
const STALE = `1.0.0${suffix}`;

/** A repository shaped like this one, at OLD, with the Docker stubs deliberately
 *  left behind at an older version — the drift this tool exists to end. */
async function writeFixture(rootDir) {
  const json = async (rel, contents) => {
    await mkdir(path.dirname(path.join(rootDir, rel)), { recursive: true });
    await writeFile(path.join(rootDir, rel), `${JSON.stringify(contents, null, 2)}\n`);
  };
  await json("package.json", { name: "polyant", version: OLD, scripts: { build: "x" } });
  await json("packages/engine/package.json", { name: releaseFacts.engineWorkspace, version: OLD });
  await json("packages/web/package.json", { name: "web", version: OLD });
  await json("infra/package.json", { name: "polyant-infra", version: OLD });

  // Two stages of one Dockerfile restate the same stub, and both are left at an
  // older version than the manifests — the drift a hand-maintained mirror list
  // produces, and which this repository actually carried.
  const stub = (pkg) => `RUN echo '{"name":"${pkg}","version":"${STALE}","private":true}' > packages/x/package.json\n`;
  for (const { file, package: pkg } of releaseFacts.dockerStubs) {
    await writeFile(path.join(rootDir, file), `FROM node:22-alpine\n${stub(pkg)}RUN npm ci\n${stub(pkg)}`);
  }

  await writeFile(
    path.join(rootDir, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
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
      `${releaseFacts.productName} v${OLD} is the current stable release. Review the [changelog](CHANGELOG.md), the`,
      `[release notes](docs/releases/v${OLD}.md), and the`,
      `[GitHub release](${releaseFacts.repositoryUrl}/releases/tag/v${OLD}). In a running`,
      "admin installation, details are at [/about](/about).",
      "",
      "## Upgrading",
      "",
      "Upgrading from 1.0.0 needs operator action.",
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

/** Versions carry dots, and one build's carries a dash: quote before regexing. */
const quote = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const read = (rootDir, rel) => readFile(path.join(rootDir, rel), "utf8");
const readJson = async (rootDir, rel) => JSON.parse(await read(rootDir, rel));

test("isValidReleaseVersion honours the edition suffix this build declares", () => {
  const plain = { ...releaseFacts, versionSuffix: null };
  const ee = { ...releaseFacts, versionSuffix: "-ee" };

  assert.equal(isValidReleaseVersion("1.2.0", plain), true);
  assert.equal(isValidReleaseVersion("1.2.0-ee", plain), false, "a suffix this build does not use");
  assert.equal(isValidReleaseVersion("1.2.0-ee", ee), true);
  assert.equal(isValidReleaseVersion("1.2.0", ee), false, "the suffix is mandatory where declared");
  assert.equal(isValidReleaseVersion("v1.2.0", plain), false, "the tag prefix is not part of the version");
  assert.equal(isValidReleaseVersion("1.2", plain), false);
});

test("releaseNoteHeading names the product, so the two builds cannot share a heading", () => {
  assert.equal(releaseNoteHeading("1.2.0", { ...releaseFacts, productName: "Polyant" }), "# Polyant v1.2.0");
  assert.equal(
    releaseNoteHeading("1.2.0-ee", { ...releaseFacts, productName: "Polyant Enterprise" }),
    "# Polyant Enterprise v1.2.0-ee",
  );
});

test("applyVersion rewrites every manifest AND every Docker stub", async () => {
  await withFixture(async (rootDir) => {
    const changed = await applyVersion(rootDir, NEW, releaseFacts);

    for (const manifest of releaseFacts.manifests) {
      assert.equal((await readJson(rootDir, manifest)).version, NEW, manifest);
    }
    // The stubs were at 1.0.0 while the manifests were at 1.1.0 — the drift a
    // hand-maintained mirror list produces. Every occurrence must move.
    for (const { file } of releaseFacts.dockerStubs) {
      assert.ok((await read(rootDir, file)).includes(`"version":"${NEW}"`), file);
      assert.ok(!(await read(rootDir, file)).includes(`"version":"${STALE}"`), `${file} still stale`);
    }
    assert.equal(changed.length, releaseFacts.manifests.length + releaseFacts.dockerStubs.length);
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

test("ensureChangelogSection inserts a dated heading under Unreleased with empty subsections", async () => {
  await withFixture(async (rootDir) => {
    await ensureChangelogSection(rootDir, NEW, "2026-09-01");
    const changelog = await read(rootDir, "CHANGELOG.md");

    const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - (\S+))?$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, ["Unreleased", NEW, OLD], "newest release first, Unreleased on top");
    assert.match(changelog, new RegExp(`## \\[${quote(NEW)}\\] - 2026-09-01\\n\\n### Added\\n\\n### Changed\\n\\n### Fixed\\n`));
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

test("retargetReadmeRelease moves only the release paragraph, not every version in the file", async () => {
  await withFixture(async (rootDir) => {
    await retargetReadmeRelease(rootDir, OLD, NEW);
    const readme = await read(rootDir, "README.md");

    assert.match(readme, new RegExp(`docs/releases/v${quote(NEW)}\\.md`));
    assert.match(readme, new RegExp(`/releases/tag/v${quote(NEW)}`));
    assert.doesNotMatch(readme, new RegExp(`v${quote(OLD)}`), "no stale reference to the previous release");
    // "Upgrading from 1.0.0" is prose about an older release: it is not a
    // pointer at the current one and must survive untouched.
    assert.match(readme, /Upgrading from 1\.0\.0 needs operator action\./);
  });
});

test("after a full prepare the metadata verifier passes", async () => {
  await withFixture(async (rootDir) => {
    await applyVersion(rootDir, NEW, releaseFacts);
    await ensureChangelogSection(rootDir, NEW, "2026-09-01");
    await ensureReleaseNote(rootDir, NEW, releaseFacts);
    await retargetReadmeRelease(rootDir, OLD, NEW);

    await validateReleaseMetadata(rootDir);
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

test("ownedPaths follows the generated artefacts this build declares, if any", () => {
  const withArtefacts = ownedPaths(NEW, {
    ...releaseFacts,
    generatedArtefacts: { script: "openapi:generate", files: ["packages/engine/openapi.json"] },
  });
  assert.ok(withArtefacts.has("packages/engine/openapi.json"));

  // This build commits no API contract, so the paths must not appear — and
  // `release:prepare` must not try to run a script the workspace does not have.
  assert.ok(!ownedPaths(NEW, { ...releaseFacts, generatedArtefacts: null }).has("packages/engine/openapi.json"));
});

test("ownedPaths covers every mirror the command writes", () => {
  const owned = ownedPaths(NEW, releaseFacts);
  for (const manifest of releaseFacts.manifests) assert.ok(owned.has(manifest), manifest);
  for (const stub of releaseFacts.dockerStubs) assert.ok(owned.has(stub.file), stub.file);
  assert.ok(owned.has("package-lock.json"));
  assert.ok(owned.has("infra/package-lock.json"));
  assert.ok(owned.has(`docs/releases/v${NEW}.md`));
});
