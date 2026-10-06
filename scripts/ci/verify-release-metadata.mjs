import { readFile } from "node:fs/promises";
import path from "node:path";

import { releaseFacts, releaseNoteHeading } from "../release/release-facts.mjs";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// The manifest list and the product name are the only things this check knows
// about the product, and both come from release-facts.mjs, shared with the
// release preparer and auditor so the three cannot disagree.
const manifestPaths = releaseFacts.manifests;

async function readManifest(rootDir, relativePath) {
  const manifestPath = path.join(rootDir, relativePath);
  const contents = await readFile(manifestPath, "utf8");
  return JSON.parse(contents);
}

async function readRequiredFile(filePath, description) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`CHANGELOG metadata is incomplete: missing ${description}.`);
    }
    throw error;
  }
}

export async function validateReleaseMetadata(rootDir) {
  const manifests = await Promise.all(
    manifestPaths.map(async (relativePath) => ({
      relativePath,
      manifest: await readManifest(rootDir, relativePath),
    })),
  );
  const rootVersion = manifests[0].manifest.version;

  if (typeof rootVersion !== "string" || !semverPattern.test(rootVersion)) {
    throw new Error("package.json must define a valid SemVer version.");
  }

  for (const { relativePath, manifest } of manifests.slice(1)) {
    if (manifest.version !== rootVersion) {
      throw new Error(
        `${relativePath} version must match package.json version ${rootVersion}.`,
      );
    }
  }

  const changelog = await readRequiredFile(
    path.join(rootDir, "CHANGELOG.md"),
    "CHANGELOG.md",
  );
  const releaseHeadings = [
    ...changelog.matchAll(/^## \[([^\]]+)] - (\d{4}-\d{2}-\d{2})$/gm),
  ];
  const firstReleaseHeading = releaseHeadings[0];

  if (
    !firstReleaseHeading ||
    firstReleaseHeading[1] !== rootVersion
  ) {
    throw new Error(
      `CHANGELOG.md must first list a dated ## [${rootVersion}] heading.`,
    );
  }

  const releaseNote = await readRequiredFile(
    path.join(rootDir, "docs", "releases", `v${rootVersion}.md`),
    `docs/releases/v${rootVersion}.md release note`,
  );
  const heading = releaseNoteHeading(rootVersion);
  if (releaseNote.split(/\r?\n/, 1)[0] !== heading) {
    throw new Error(
      `CHANGELOG metadata is incomplete: docs/releases/v${rootVersion}.md must begin with the exact H1 ${heading}.`,
    );
  }

  const readme = await readRequiredFile(path.join(rootDir, "README.md"), "README.md");
  for (const reference of [
    "CHANGELOG.md",
    `/releases/tag/v${rootVersion}`,
    "/about",
  ]) {
    if (!readme.includes(reference)) {
      throw new Error(`README.md must reference ${reference}.`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateReleaseMetadata(process.cwd()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
