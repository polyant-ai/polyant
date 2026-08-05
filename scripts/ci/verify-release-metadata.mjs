import { readFile } from "node:fs/promises";
import path from "node:path";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const manifestPaths = [
  "package.json",
  "packages/engine/package.json",
  "packages/web/package.json",
  "infra/package.json",
];

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
  const headings = [...changelog.matchAll(/^## \[([^\]]+)](?: - (\d{4}-\d{2}-\d{2}))?$/gm)];
  const unreleasedIndex = headings.findIndex(([, version]) => version === "Unreleased");
  const firstReleaseHeading = headings[unreleasedIndex + 1];

  if (
    unreleasedIndex !== 0 ||
    !firstReleaseHeading ||
    firstReleaseHeading[1] !== rootVersion ||
    !firstReleaseHeading[2]
  ) {
    throw new Error(
      `CHANGELOG.md must list ## [Unreleased] followed by a dated ## [${rootVersion}] heading.`,
    );
  }

  const releaseNote = await readRequiredFile(
    path.join(rootDir, "docs", "releases", `v${rootVersion}.md`),
    `docs/releases/v${rootVersion}.md release note`,
  );
  if (!releaseNote.startsWith(`# Polyant v${rootVersion}`)) {
    throw new Error(
      `CHANGELOG metadata is incomplete: docs/releases/v${rootVersion}.md must begin with # Polyant v${rootVersion}.`,
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
