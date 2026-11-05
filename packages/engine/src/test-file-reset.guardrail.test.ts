// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type ProjectConfig = { test?: { name?: string; isolate?: boolean; setupFiles?: string[] } };

// Loaded by URL so the type checker, whose root is src/, does not follow it.
const configUrl = pathToFileURL(resolve(import.meta.dirname, "../vitest.config.ts")).href;

describe("test projects that share workers between files", () => {
  // Removing the per-file reset breaks nothing on the day it is removed: state
  // starts leaking between files and fails later, in an unrelated test.
  it("run the per-file reset before any other setup", async () => {
    const config = (await import(configUrl)).default as { test: { projects: ProjectConfig[] } };
    const shared = config.test.projects.filter((p) => p.test?.isolate === false);
    expect(shared.map((p) => p.test?.name)).toContain("unit");
    for (const project of shared) {
      expect(project.test?.setupFiles?.[0]).toBe("./src/test-file-reset.setup.ts");
    }
  });
});
