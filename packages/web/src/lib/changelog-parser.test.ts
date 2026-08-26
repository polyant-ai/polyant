// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseChangelog } from "./changelog-parser";

describe("parseChangelog", () => {
  it("skips the Unreleased section", () => {
    const result = parseChangelog(`
## [Unreleased]

### Added

- Something not yet shipped

## [1.0.0] - 2026-01-01

### Added

- First release
`);
    expect(result).toHaveLength(1);
    expect(result[0]!.version).toBe("1.0.0");
  });

  it("parses version, date and categorized items", () => {
    const result = parseChangelog(`
## [1.1.0] - 2026-08-25

### Added

- First item
- Second item

### Fixed

- A fix
`);
    expect(result).toEqual([
      {
        version: "1.1.0",
        date: "2026-08-25",
        changes: [
          { category: "Added", items: ["First item", "Second item"] },
          { category: "Fixed", items: ["A fix"] },
        ],
      },
    ]);
  });

  it("joins wrapped continuation lines back into a single item", () => {
    const result = parseChangelog(`
## [1.1.0] - 2026-08-25

### Added

- **MCP client**: an agent can equip tools from external Model Context Protocol
  servers, configured per agent, with \`none\` / \`static\` / OAuth 2.1 auth modes.
- A short one-liner
`);
    expect(result[0]!.changes[0]!.items).toEqual([
      "**MCP client**: an agent can equip tools from external Model Context Protocol servers, configured per agent, with `none` / `static` / OAuth 2.1 auth modes.",
      "A short one-liner",
    ]);
  });

  it("captures a multi-line blockquote notice preceding the first category", () => {
    const result = parseChangelog(`
## [1.1.0] - 2026-08-25

> **Upgrading from 1.0.0 needs operator action** — this release is not a rolling
> upgrade. See [docs/UPGRADING.md](docs/UPGRADING.md).

### Added

- Something
`);
    expect(result[0]!.notice).toBe(
      "**Upgrading from 1.0.0 needs operator action** — this release is not a rolling upgrade. See [docs/UPGRADING.md](docs/UPGRADING.md).",
    );
  });

  it("omits notice when there is none", () => {
    const result = parseChangelog(`
## [1.0.0] - 2026-01-01

### Added

- Something
`);
    expect(result[0]!.notice).toBeUndefined();
  });

  it("parses multiple versions in order", () => {
    const result = parseChangelog(`
## [1.1.0] - 2026-08-25

### Added

- Newer

## [1.0.0] - 2026-01-01

### Added

- Older
`);
    expect(result.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("returns an empty array for content with no version headers", () => {
    expect(parseChangelog("# Changelog\n\nNothing here yet.\n")).toEqual([]);
  });
});
