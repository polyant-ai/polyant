// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ChangelogChange {
  category: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  notice?: string;
  changes: ChangelogChange[];
}

export interface ChangelogData {
  version: string;
  releaseDate: string;
  buildDate: string;
  generated: string;
  source: string;
  changelog: ChangelogEntry[];
}
