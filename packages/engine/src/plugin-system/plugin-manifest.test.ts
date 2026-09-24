// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { readPluginManifest, engineSatisfies, pluginManifestSchema } from "./plugin-manifest.js";

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
  const mk = (engine: string) => ({ name: "p", version: "1.0.0", engine, toolsDir: "tools", hooksDir: "hooks", namespace: "p", oauthProviders: [], system: { apk: [], npmGlobal: [], env: {} } });

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

  it("ignores a prerelease tag on the ENGINE version", () => {
    // semver excludes a prerelease from a range that carries none, so these
    // were all false: one suffixed release would have silently skipped every
    // third-party plugin at boot, leaving the agent tool-less with a warning
    // nobody reads and a green deploy.
    expect(engineSatisfies(mk(">=0.1.0"), "1.1.0-beta.1")).toBe(true);
    expect(engineSatisfies(mk("^1.1.0"), "1.1.0-rc1")).toBe(true);
    expect(engineSatisfies(mk("^1.0.0"), "1.1.0-ee")).toBe(true);
  });

  it("still refuses a prerelease version whose NUMBERS are outside the range", () => {
    // The suffix is ignored, not the version: this must not become a bypass.
    expect(engineSatisfies(mk(">=99.0.0"), "1.1.0-beta.1")).toBe(false);
    expect(engineSatisfies(mk("^2.0.0"), "1.9.9-rc1")).toBe(false);
  });
});

describe("oauthProviders in manifest", () => {
  const base = { name: "p", version: "1.0.0", engine: ">=0.1.0" };

  it("defaults to [] when absent", () => {
    const r = pluginManifestSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.oauthProviders).toEqual([]);
  });

  it("parses a provider and defaults extraAuthorizeParams + pkce", () => {
    const r = pluginManifestSchema.safeParse({
      ...base,
      oauthProviders: [{ name: "notion", authorizeUrl: "https://a", tokenUrl: "https://t", scope: "read" }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.oauthProviders[0]).toMatchObject({ name: "notion", extraAuthorizeParams: {}, pkce: false });
    }
  });

  it("rejects a provider missing tokenUrl", () => {
    const r = pluginManifestSchema.safeParse({
      ...base,
      oauthProviders: [{ name: "x", authorizeUrl: "https://a", scope: "" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("pluginManifestSchema — system requirements", () => {
  const base = { name: "p", version: "1.0.0", engine: ">=1.0.0" };

  it("defaults to empty when absent — a plugin that needs nothing declares nothing", () => {
    const r = pluginManifestSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.system).toEqual({ apk: [], npmGlobal: [], env: {} });
  });

  it("parses packages and env, and fills the lists it was not given", () => {
    const r = pluginManifestSchema.safeParse({
      ...base,
      system: {
        apk: ["chromium", "nss"],
        env: { PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium-browser" },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.system.apk).toEqual(["chromium", "nss"]);
      expect(r.data.system.npmGlobal).toEqual([]);
      expect(r.data.system.env.PUPPETEER_EXECUTABLE_PATH).toBe("/usr/bin/chromium-browser");
    }
  });

  it("rejects a non-string env value rather than coercing it into an image", () => {
    const r = pluginManifestSchema.safeParse({ ...base, system: { env: { PORT: 4000 } } });
    expect(r.success).toBe(false);
  });

  it("rejects an empty package name", () => {
    const r = pluginManifestSchema.safeParse({ ...base, system: { apk: [""] } });
    expect(r.success).toBe(false);
  });
});

describe("displayName and description in manifest", () => {
  const base = { name: "p", version: "1.0.0", engine: ">=0.1.0" };

  it("are optional: a manifest without them is still valid", () => {
    const r = pluginManifestSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.displayName).toBeUndefined();
      expect(r.data.description).toBeUndefined();
    }
  });

  it("are carried through when present", () => {
    const r = pluginManifestSchema.safeParse({ ...base, displayName: "CRM", description: "Contacts and deals." });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ displayName: "CRM", description: "Contacts and deals." });
  });

  it("reject an empty string, which would render as a blank name", () => {
    expect(pluginManifestSchema.safeParse({ ...base, displayName: "" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, description: "" }).success).toBe(false);
  });
});
