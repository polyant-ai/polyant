// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Guard-rail: a tool file that the loader does not pick up must fail a test,
 * not disappear.
 *
 * `importRoot` globs for `*.tool.(ts|js)`. A tool file whose name misses that
 * pattern is never imported, so it is never registered, so `syncToolsToDb`
 * never writes its catalog row — and without a catalog row the tool cannot be
 * enabled on any agent, cannot appear in the panel, and cannot be named in
 * `PATCH /api/instances/:slug/tools`. Nothing reports any of this: there is no
 * error, no warning (the warn only fires for a file that DID match the glob and
 * had no default export), and no failing test.
 *
 * That is how `spawnTask` was unreachable from the first commit (oss#377): its
 * file was `task-tool.ts`, a hyphen where the glob wants a dot. Every consumer
 * downstream was correctly wired for it — `buildTools` skips meta-tools so the
 * supervisor can build the real one, the catalog carries an `is_meta` column,
 * the strict-mode sweep skips meta-tools — all of it waiting on a registry
 * entry that was never created.
 *
 * Discovery is by `export default`, not by filename, because the filename is
 * precisely what the bug gets wrong: asking the filesystem the same question
 * the loader asks would reproduce the blind spot instead of catching it.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadAllTools, getToolRegistry } from "./registry.js";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

/** Every non-test module in this directory that default-exports something —
 *  the shape of a tool module, whatever the file is called. */
function toolModuleFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => /\.(ts|js)$/.test(f) && !/\.(test|spec)\.(ts|js)$/.test(f))
    .filter((f) => /^export default /m.test(readFileSync(join(TOOLS_DIR, f), "utf-8")))
    .sort();
}

describe("core tool discovery", () => {
  beforeAll(async () => {
    await loadAllTools();
  });

  it("registers every tool module in the core tools directory", async () => {
    const files = toolModuleFiles();
    expect(files.length, "no tool modules discovered — is the directory scan still right?").toBeGreaterThan(0);

    const registered = new Set(getToolRegistry().keys());
    const unreachable: string[] = [];

    for (const file of files) {
      const mod = (await import(join(TOOLS_DIR, file))) as { default?: { name?: string } };
      const name = mod.default?.name;
      if (!name) continue; // default export that is not a tool definition
      if (!registered.has(name)) {
        unreachable.push(`${file} defines "${name}", which the loader never registered`);
      }
    }

    expect(
      unreachable,
      `\n${unreachable.length} tool(s) unreachable — the file name must match the loader's *.tool.(ts|js) glob:\n  - ${unreachable.join("\n  - ")}\n`,
    ).toEqual([]);
  });
});
