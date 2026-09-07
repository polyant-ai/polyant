// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChangelogEntry } from "./changelog-types";

/**
 * Loose semver comparison (major.minor.patch, no pre-release/build metadata
 * handling beyond a leading "v"). Deliberately dependency-free: this only
 * needs to order the versions CHANGELOG.md already lists.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/, "").split(".");
  const partsB = b.replace(/^v/, "").split(".");
  const length = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < length; i++) {
    const numA = parseInt(partsA[i] ?? "0", 10);
    const numB = parseInt(partsB[i] ?? "0", 10);
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

/**
 * Changelog entries the caller has not seen yet, newest first.
 * `lastSeenVersion` null means first visit — every entry up to
 * `currentVersion` is unseen.
 */
export function extractUnseenChangelogs(
  lastSeenVersion: string | null,
  currentVersion: string,
  entries: ChangelogEntry[],
): ChangelogEntry[] {
  return entries
    .filter((entry) => {
      const isAfterLastSeen = lastSeenVersion === null || compareVersions(entry.version, lastSeenVersion) > 0;
      const isUpToCurrent = compareVersions(entry.version, currentVersion) <= 0;
      return isAfterLastSeen && isUpToCurrent;
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}
