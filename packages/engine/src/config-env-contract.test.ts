// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(sourceDirectory, "config.ts");
const samplePath = resolve(sourceDirectory, "../../../.env.example");
const packageRoot = resolve(sourceDirectory, "..");
const execFileAsync = promisify(execFile);
const runtimeProvidedEnvironment = new Set(["NODE_ENV", "TZ", "LANG", "LC_ALL"]);

function tsxProbeForPlatform(platform: NodeJS.Platform): { path: string; shell: boolean } {
  const shell = platform === "win32";
  return {
    path: resolve(packageRoot, "../../node_modules/.bin", shell ? "tsx.cmd" : "tsx"),
    shell,
  };
}

const tsxProbe = tsxProbeForPlatform(process.platform);

function directEnvironmentNames(source: string): string[] {
  return [...new Set(
    [...source.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
      .filter((name) => !runtimeProvidedEnvironment.has(name)),
  )].sort();
}

function documentedEnvironmentNames(sample: string): Set<string> {
  return new Set(
    [...sample.matchAll(/^[ \t]*(?:#\s*)?([A-Z][A-Z0-9_]*)[ \t]*=/gm)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined),
  );
}

function activeEnvironmentValues(sample: string): Map<string, string> {
  return new Map(
    [...sample.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/gm)]
      .map((match) => [match[1], match[2].trim()] as const)
      .filter((entry): entry is readonly [string, string] => entry[0] !== undefined && entry[1] !== undefined),
  );
}

describe("configuration environment contract", () => {
  it("selects the Windows tsx command shim through cmd.exe", () => {
    expect(tsxProbeForPlatform("win32")).toEqual({
      path: resolve(packageRoot, "../../node_modules/.bin/tsx.cmd"),
      shell: true,
    });
    expect(tsxProbeForPlatform("linux")).toEqual({
      path: resolve(packageRoot, "../../node_modules/.bin/tsx"),
      shell: false,
    });
  });

  it("documents every direct config.ts process.env access in .env.example", () => {
    const configSource = readFileSync(configPath, "utf8");
    const sampleSource = readFileSync(samplePath, "utf8");
    const documented = documentedEnvironmentNames(sampleSource);
    const missing = directEnvironmentNames(configSource).filter((name) => !documented.has(name));

    expect(missing, "Missing from .env.example").toEqual([]);
  });

  it("loads config from the copied sample after injecting only required secrets", async () => {
    const sampleValues = Object.fromEntries(activeEnvironmentValues(readFileSync(samplePath, "utf8")));

    await expect(execFileAsync(tsxProbe.path, [configPath], {
      cwd: packageRoot,
      env: {
        PATH: process.env.PATH,
        ...sampleValues,
        ENCRYPTION_KEY: "0".repeat(64),
        AUTH_SECRET: "a".repeat(32),
      },
      encoding: "utf8",
      shell: tsxProbe.shell,
    })).resolves.toMatchObject({ stderr: "" });
  });

  it("documents the RBAC enforcement switch, which IS read here", () => {
    // The mirror of the enterprise assertion, and deliberately inverted:
    // `AUTHZ_ENFORCE` is the real knob on this side (enforcement is opt-in,
    // shadow mode is the default), so it MUST be documented. Enterprise enforces
    // by default and does not read it at all — see its
    // `REMOVE_AUTHORIZATION_FILTER_FOR_TESTING` — so the same test there asserts
    // the opposite. Do not "align" the two on a merge: they are two different
    // contracts, not a drift.
    const documented = documentedEnvironmentNames(readFileSync(samplePath, "utf8"));

    expect(documented.has("AUTHZ_ENFORCE")).toBe(true);
  });
});
