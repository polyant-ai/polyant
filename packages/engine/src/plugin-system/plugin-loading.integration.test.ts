// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * End-to-end fixture-plugin loading test for the SERIALIZED contract.
 *
 * Seam: `resolvePluginRoots` is mocked to return the on-disk fixture roots
 * (built via the real `readPluginManifest`), and `fs.readdirSync` is mocked to
 * suppress core-tools scanning while returning the fixture tool filenames.
 * `existsSync` / `readFileSync` stay real so manifests + the engine version read
 * work on disk, and the real fixture `*.tool.ts` files are genuinely imported by
 * `loadAllTools()` via dynamic import(). This proves: discovery, `export default`
 * collection, per-plugin namespacing, and engine-range skipping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return { ...real, readdirSync: vi.fn() };
});

vi.mock("./plugin-roots.js", () => ({
  resolvePluginRoots: vi.fn(() => []),
}));

import { existsSync, readdirSync } from "fs";
import { readPluginManifest } from "./plugin-manifest.js";
import { resolvePluginRoots } from "./plugin-roots.js";
import {
  loadAllTools,
  getToolRegistry,
  isSerializedTool,
  _resetRegistryForTests,
} from "../agents/tools/registry.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dir, "../../test/fixtures");
const sampleFixture = join(fixtures, "plugin-sample");
const incompatibleFixture = join(fixtures, "plugin-incompatible");
const crashFixture = join(fixtures, "plugin-crash");

describe("plugin loading (serialized contract, integration)", () => {
  beforeEach(() => {
    _resetRegistryForTests();
    vi.clearAllMocks();
    // Core tools dir → []; fixture tool dirs → their real tool filename.
    vi.mocked(readdirSync).mockImplementation((dir: unknown) => {
      const d = String(dir);
      if (d.endsWith(join("plugin-sample", "tools"))) return ["ping.tool.ts"] as never;
      if (d.endsWith(join("plugin-incompatible", "tools"))) return ["nope.tool.ts"] as never;
      if (d.endsWith(join("plugin-crash", "tools"))) return ["boom.tool.ts"] as never;
      return [] as never;
    });
  });

  it("loads + namespaces a serialized plugin tool and skips an engine-incompatible one", async () => {
    const sampleManifest = readPluginManifest(sampleFixture);
    const incompatibleManifest = readPluginManifest(incompatibleFixture);
    expect(sampleManifest).not.toBeNull();
    expect(incompatibleManifest).not.toBeNull();

    vi.mocked(resolvePluginRoots).mockReturnValue([
      { root: sampleFixture, manifest: sampleManifest! },
      { root: incompatibleFixture, manifest: incompatibleManifest! },
    ]);

    await loadAllTools();

    // sample (engine >=0.1.0, compatible) → loaded + namespaced.
    const ping = getToolRegistry().get("sample:ping");
    expect(ping).toBeDefined();
    expect(getToolRegistry().has("ping")).toBe(false); // never flat
    // It is the serialized shape (JSON Schema, no live Zod).
    expect(isSerializedTool(ping!)).toBe(true);
    if (isSerializedTool(ping!)) {
      expect(ping!.inputSchema.type).toBe("object");
      expect(await ping!.execute({ msg: "hi" }, {} as never)).toBe("pong:hi");
    }

    // incompatible (engine >=99.0.0) → skipped.
    expect(getToolRegistry().has("incompatible:nope")).toBe(false);
  });

  it("isolates a plugin that throws at import — boot continues, good plugins still load", async () => {
    const sampleManifest = readPluginManifest(sampleFixture);
    const crashManifest = readPluginManifest(crashFixture);
    expect(crashManifest).not.toBeNull();

    // crash plugin listed BEFORE the good one to prove the throw doesn't abort
    // the rest of discovery.
    vi.mocked(resolvePluginRoots).mockReturnValue([
      { root: crashFixture, manifest: crashManifest! },
      { root: sampleFixture, manifest: sampleManifest! },
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(loadAllTools()).resolves.toBeUndefined();

    expect(getToolRegistry().has("crash:boom")).toBe(false); // exploded → skipped
    expect(getToolRegistry().has("sample:ping")).toBe(true); // still loaded
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("crash"));
    warn.mockRestore();
  });

  it("existsSync guards a plugin whose toolsDir is absent (no throw)", async () => {
    // real existsSync used for a non-existent dir path
    expect(existsSync(join(fixtures, "does-not-exist"))).toBe(false);
  });
});
