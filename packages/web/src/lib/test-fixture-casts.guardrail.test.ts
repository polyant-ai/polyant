// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A fake engine response written as a literal and cast (`as unknown as Instance`,
 * `as never`) type-checks whatever it contains, so it keeps passing after the
 * panel's declared type gains a required field or renames one: the test then
 * exercises a shape the panel no longer receives. The fixture builders in
 * `src/test-fixtures/` return values that satisfy the real type; a fixture is
 * built with them, or typed with `satisfies`, and never forced through a cast.
 *
 * Casts that are not about an API fixture (browser globals, third-party hooks,
 * mock call tuples) are listed below with the number allowed per file and the
 * reason. A new cast in a test file fails here until it is removed or listed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const CAST = /\bas (?:unknown as|never(?=\s*[)\],;}>]|\s*$)|any(?=\s*[)\],;}>]|\s*$))/;

/** file (relative to src) -> allowed cast count and why it is not an API fixture. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "components/layout/activity-ticker/activity-ticker.test.tsx": { count: 2, reason: "EventSource global replaced by a fake" },
  "components/layout/activity-ticker/use-activity-ticker.test.tsx": { count: 2, reason: "EventSource global replaced by a fake" },
  "lib/activity-stream/provider.test.tsx": { count: 2, reason: "EventSource global replaced by a fake" },
  "components/layout/nav-main.test.tsx": { count: 1, reason: "window.matchMedia stub" },
  "hooks/use-changelog-check.test.ts": { count: 1, reason: "next-auth useSession return, a third-party type" },
  "app/(admin)/about/page.test.tsx": { count: 1, reason: "next-auth useSession return, a third-party type" },
  "lib/format.test.ts": { count: 9, reason: "i18n translator stub, not an API shape" },
  "lib/stream-parser.test.ts": { count: 1, reason: "fetch mock call tuple" },
  "lib/markdown/rehype-stream-words.test.ts": { count: 2, reason: "hast tree literal for a rehype plugin" },
  "lib/auth.config.test.ts": { count: 2, reason: "next-auth callbacks narrowed to the two under test" },
  "components/analytics/analytics-dashboard.test.tsx": {
    count: 1,
    reason: "AnalyticsFetcher is generic over the part; a plain mock cannot satisfy its conditional return (the resolved values are typed)",
  },
  "app/(admin)/organizations/[orgSlug]/workspaces/[workspaceSlug]/instances/[slug]/mcp-servers-tab.test.tsx": {
    count: 1,
    reason: "window.open return value",
  },
};

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.test\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

function castCount(file: string): number {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && CAST.test(line)).length;
}

describe("test fixtures obey the panel's types", () => {
  const files = testFiles(SRC).filter((f) => !f.endsWith("test-fixture-casts.guardrail.test.ts"));
  const counts = new Map(files.map((f) => [relative(SRC, f), castCount(f)]));

  it("finds the panel's test files and the casts already listed", () => {
    // Non-vacuity: a wrong root or a regex that matches nothing would pass every check below.
    expect(files.length).toBeGreaterThan(100);
    for (const [file, { count }] of Object.entries(ALLOWED)) {
      expect(counts.get(file), `${file} is in the allowlist but is gone or has no casts`).toBe(count);
    }
  });

  it("allows no cast beyond the documented ones", () => {
    const over = [...counts]
      .filter(([file, n]) => n > (ALLOWED[file]?.count ?? 0))
      .map(([file, n]) => `${file}: ${n} cast(s), ${ALLOWED[file]?.count ?? 0} allowed`);
    expect(over, "Build the fixture with src/test-fixtures/ or `satisfies`, or list the cast with its reason").toEqual([]);
  });
});
