// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { readPluginManifest, engineSatisfies } from "./plugin-manifest.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dir, "../../test/fixtures");

describe("readPluginManifest", () => {
  it("reads a valid manifest and defaults toolsDir; namespace falls back to name", () => {
    const m = readPluginManifest(join(fixtures, "plugin-sample"));
    expect(m).not.toBeNull();
    expect(m!.name).toBe("sample");
    expect(m!.toolsDir).toBe("tools");
    expect(m!.namespace).toBe("sample");
  });

  it("returns null for a directory without plugin.json", () => {
    expect(readPluginManifest(join(fixtures, "does-not-exist"))).toBeNull();
  });
});

describe("engineSatisfies", () => {
  const mk = (engine: string) => ({ name: "p", version: "1.0.0", engine, toolsDir: "tools", namespace: "p" });

  it("true when the engine version is inside the range", () => {
    expect(engineSatisfies(mk(">=0.1.0"), "0.1.0")).toBe(true);
    expect(engineSatisfies(mk("^0.1.0"), "0.1.5")).toBe(true);
  });

  it("false when outside the range", () => {
    expect(engineSatisfies(mk(">=99.0.0"), "0.1.0")).toBe(false);
  });

  it("fail-closed on an unparseable range or version", () => {
    expect(engineSatisfies(mk("not-a-range"), "0.1.0")).toBe(false);
    expect(engineSatisfies(mk(">=0.1.0"), "garbage")).toBe(false);
  });
});
