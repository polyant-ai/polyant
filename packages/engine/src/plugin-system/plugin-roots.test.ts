// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { resolvePluginRoots } from "./plugin-roots.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dir, "../../test/fixtures");

describe("resolvePluginRoots", () => {
  it("resolves an env dir that carries a valid plugin.json", () => {
    const roots = resolvePluginRoots({
      envDirs: [join(fixtures, "plugin-sample")],
      conventionDir: join(fixtures, "does-not-exist"),
    });
    expect(roots.map((r) => r.manifest.name)).toEqual(["sample"]);
  });

  it("skips dirs without a plugin.json", () => {
    const roots = resolvePluginRoots({
      envDirs: [join(fixtures, "does-not-exist")],
      conventionDir: join(fixtures, "does-not-exist"),
    });
    expect(roots).toEqual([]);
  });

  it("de-duplicates by manifest name (first/env source wins)", () => {
    const sample = join(fixtures, "plugin-sample");
    const roots = resolvePluginRoots({ envDirs: [sample, sample], conventionDir: sample });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.manifest.name).toBe("sample");
  });
});
