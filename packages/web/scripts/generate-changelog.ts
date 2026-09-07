#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Parses the monorepo root CHANGELOG.md and writes public/changelog.json,
 * the static data source for the About page and the "new version" modal.
 * Runs at predev/prebuild, mirroring how next.config.ts reads package.json
 * for NEXT_PUBLIC_APP_VERSION — no backend endpoint involved.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseChangelog } from "../src/lib/changelog-parser";
import type { ChangelogData } from "../src/lib/changelog-types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = resolve(__dirname, "../../../CHANGELOG.md");
const PACKAGE_JSON_PATH = resolve(__dirname, "../package.json");
const OUTPUT_PATH = resolve(__dirname, "../public/changelog.json");

function main() {
  if (!existsSync(CHANGELOG_PATH)) {
    console.error(`CHANGELOG.md not found at ${CHANGELOG_PATH}`);
    process.exit(1);
  }

  const changelog = parseChangelog(readFileSync(CHANGELOG_PATH, "utf-8"));
  if (changelog.length === 0) {
    console.error("No versions found in CHANGELOG.md");
    process.exit(1);
  }

  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as { version: string };
  const latest = changelog[0]!;

  const data: ChangelogData = {
    version: packageJson.version,
    releaseDate: latest.date,
    buildDate: new Date().toISOString().split("T")[0]!,
    generated: new Date().toISOString(),
    source: "CHANGELOG.md",
    changelog,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2), "utf-8");
  console.log(`changelog.json generated (${changelog.length} versions, latest ${latest.version})`);
}

main();
