// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChangelogChange, ChangelogEntry } from "./changelog-types";

/**
 * Parses a Keep a Changelog-formatted CHANGELOG.md into structured entries.
 *
 * Unlike a changelog that never wraps a bullet past one line, this repo's
 * CHANGELOG.md hard-wraps prose at ~80 columns with 2-space-indented
 * continuation lines, and prefixes some releases with a blockquote operator
 * notice (e.g. the 1.1.0 upgrade warning) before the first `###` category.
 * Both are folded back into a single string rather than dropped.
 */
export function parseChangelog(content: string): ChangelogEntry[] {
  const versions: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentCategory: ChangelogChange | null = null;
  let noticeLines: string[] = [];

  const flushNotice = () => {
    if (current && noticeLines.length > 0) {
      current.notice = noticeLines.join(" ").trim();
    }
    noticeLines = [];
  };

  for (const line of content.split("\n")) {
    const versionMatch = line.match(/^##\s+\[([^\]]+)\]\s+-\s+(.+)$/);
    if (versionMatch) {
      flushNotice();
      if (current) versions.push(current);
      current = { version: versionMatch[1]!, date: versionMatch[2]!.trim(), changes: [] };
      currentCategory = null;
      continue;
    }

    if (line.match(/^##\s+\[Unreleased\]/i)) {
      flushNotice();
      current = null;
      currentCategory = null;
      continue;
    }

    if (!current) continue;

    const categoryMatch = line.match(/^###\s+(.+)$/);
    if (categoryMatch) {
      flushNotice();
      currentCategory = { category: categoryMatch[1]!.trim(), items: [] };
      current.changes.push(currentCategory);
      continue;
    }

    const itemMatch = line.match(/^-\s+(.+)$/);
    if (itemMatch) {
      currentCategory?.items.push(itemMatch[1]!.trim());
      continue;
    }

    const blockquoteMatch = line.match(/^>\s?(.*)$/);
    if (blockquoteMatch && !currentCategory) {
      if (blockquoteMatch[1]) noticeLines.push(blockquoteMatch[1].trim());
      continue;
    }

    if (line.trim() === "") continue;

    // Wrapped continuation of the previous bullet.
    if (currentCategory && currentCategory.items.length > 0) {
      const lastIndex = currentCategory.items.length - 1;
      currentCategory.items[lastIndex] = `${currentCategory.items[lastIndex]} ${line.trim()}`;
    }
  }

  flushNotice();
  if (current) versions.push(current);

  return versions;
}
