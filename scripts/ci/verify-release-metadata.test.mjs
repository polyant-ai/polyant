import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateReleaseMetadata } from "./verify-release-metadata.mjs";

const VERSION = "1.0.0";

async function writeJson(rootDir, relativePath, contents) {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`);
}

async function writeFixture(rootDir, { webVersion = VERSION } = {}) {
  await Promise.all([
    writeJson(rootDir, "package.json", { version: VERSION }),
    writeJson(rootDir, "packages/engine/package.json", { version: VERSION }),
    writeJson(rootDir, "packages/web/package.json", { version: webVersion }),
    writeJson(rootDir, "infra/package.json", { version: VERSION }),
  ]);
  await mkdir(path.join(rootDir, "docs/releases"), { recursive: true });
  await writeFile(
    path.join(rootDir, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-08-05\n",
  );
  await writeFile(
    path.join(rootDir, "docs/releases/v1.0.0.md"),
    "# Polyant v1.0.0\n\nRelease notes.\n",
  );
  await writeFile(
    path.join(rootDir, "README.md"),
    "See CHANGELOG.md, /releases/tag/v1.0.0, and /about.\n",
  );
}

async function withFixture(options, callback) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "polyant-release-metadata-"));
  try {
    await writeFixture(rootDir, options);
    await callback(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("accepts synchronized release metadata", async () => {
  await withFixture({}, async (rootDir) => {
    await validateReleaseMetadata(rootDir);
  });
});

test("rejects a mismatched workspace version", async () => {
  await withFixture({ webVersion: "0.1.0" }, async (rootDir) => {
    await assert.rejects(
      validateReleaseMetadata(rootDir),
      /packages\/web\/package\.json/,
    );
  });
});

test("rejects a missing dated changelog heading or release note", async (t) => {
  await t.test("missing dated release heading", async () => {
    await withFixture({}, async (rootDir) => {
      await writeFile(
        path.join(rootDir, "CHANGELOG.md"),
        "# Changelog\n\n## [Unreleased]\n",
      );
      await assert.rejects(validateReleaseMetadata(rootDir), /CHANGELOG/);
    });
  });

  await t.test("missing release note", async () => {
    await withFixture({}, async (rootDir) => {
      await rm(path.join(rootDir, "docs/releases/v1.0.0.md"));
      await assert.rejects(validateReleaseMetadata(rootDir), /CHANGELOG/);
    });
  });
});
