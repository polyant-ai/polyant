import assert from "node:assert/strict";
import test from "node:test";

import {
  datedChangelogVersions,
  changelogSectionsMissingHere,
  describeVersionDrift,
  selectPreviousReleaseTag,
  dropCommitsAlreadyHereBySubject,
} from "./audit.mjs";
import { releaseFacts } from "./release-facts.mjs";

const HERE = ["# Changelog", "", "## [Unreleased]", "", "## [1.1.0] - 2026-08-26", "", "## [1.0.0] - 2026-08-05", ""].join("\n");
const RELEASE_BRANCH = [
  "# Changelog",
  "",
  "## [1.0.2] - 2026-08-26",
  "",
  "## [1.0.1] - 2026-08-25",
  "",
  "## [1.0.0] - 2026-08-05",
  "",
].join("\n");

test("datedChangelogVersions reads released versions only, newest first", () => {
  assert.deepEqual(datedChangelogVersions(HERE), ["1.1.0", "1.0.0"]);
  // `## [Unreleased]` carries no date and is not a release.
  assert.ok(!datedChangelogVersions(HERE).includes("Unreleased"));
});

test("changelogSectionsMissingHere finds the hotfixes a release branch shipped and never sent back", () => {
  // The real case: 1.0.1 and 1.0.2 shipped from main, and the back-merge that
  // should have returned their sections never did — so the working branch's
  // changelog jumped from 1.0.0 straight to the next minor.
  assert.deepEqual(changelogSectionsMissingHere(HERE, RELEASE_BRANCH), ["1.0.2", "1.0.1"]);
});

test("changelogSectionsMissingHere is quiet when nothing is missing", () => {
  assert.deepEqual(changelogSectionsMissingHere(RELEASE_BRANCH, RELEASE_BRANCH), []);
  assert.deepEqual(changelogSectionsMissingHere(HERE, "# Changelog\n"), []);
});

test("describeVersionDrift reports a working branch left behind by its own releases", () => {
  const behind = describeVersionDrift("1.0.0-ee", "1.0.2-ee");
  assert.equal(behind.drifted, true);
  assert.match(behind.message, /1\.0\.0-ee/);
  assert.match(behind.message, /1\.0\.2-ee/);

  assert.equal(describeVersionDrift("1.1.0", "1.1.0").drifted, false);
});

test("selectPreviousReleaseTag ignores the other build's tags", () => {
  // Both products' tags can sit in one object store (a worktree of one repo
  // checked out from the other's remote), and `v1.0.2-ee` sorts above `v1.0.2`.
  // Picking it would range the changelog against a release this build never cut.
  const tags = ["v1.0.2-ee", "v1.0.2", "v1.0.1-ee", "v1.0.1", "v1.0.0"];

  assert.equal(selectPreviousReleaseTag(tags, { ...releaseFacts, versionSuffix: null }), "v1.0.2");
  assert.equal(selectPreviousReleaseTag(tags, { ...releaseFacts, versionSuffix: "-ee" }), "v1.0.2-ee");
  assert.equal(selectPreviousReleaseTag(["not-a-tag", "v1.2"], { ...releaseFacts, versionSuffix: null }), null);
  assert.equal(selectPreviousReleaseTag([], releaseFacts), null);
});

test("dropCommitsAlreadyHereBySubject removes ports that patch-id cannot recognise", () => {
  // A commit cherry-picked or adapted on arrival keeps its subject and loses its
  // patch id, so patch-id alone reports it as missing. The subject is a weaker
  // signal but a real one, and it is what turns a 20-line list of mostly-present
  // commits into the few worth opening.
  const candidates = [
    { sha: "aaa1111", subject: "feat(whatsapp): mint the inbound webhook secret" },
    { sha: "bbb2222", subject: "fix(plugins): the edition suffix stops disabling every plugin" },
  ];
  const subjectsHere = new Set(["feat(whatsapp): mint the inbound webhook secret", "chore: unrelated"]);

  assert.deepEqual(dropCommitsAlreadyHereBySubject(candidates, subjectsHere), [
    { sha: "bbb2222", subject: "fix(plugins): the edition suffix stops disabling every plugin" },
  ]);
});
