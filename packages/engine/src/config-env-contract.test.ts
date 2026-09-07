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

/** Every name the sample mentions, whether active or commented out. */
function allSampleNames(sample: string): string[] {
  return [...documentedEnvironmentNames(sample)];
}

describe("configuration environment contract", () => {
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

  /**
   * A `VAR=` line is the shape a `.env` file uses to say "not set", and it
   * arrives as `""` rather than `undefined` — which `.optional()` rejects and
   * `.default()` ignores. So EVERY name the sample mentions must survive being
   * present-and-empty, not just the ones someone remembered to special-case.
   *
   * This is the test that would have caught the original bug, and it is
   * deliberately stronger than "the sample boots": the sample's own commented-out
   * lines never reach a plain boot, and `config.ts` calls `dotenv.config()` on
   * the real repo `.env`, so anything the sample leaves commented is silently
   * filled in from the developer's machine. Passing every name EXPLICITLY as ""
   * is what takes the ambient file out of the picture for those names.
   */
  it("boots with every documented variable present but empty", async () => {
    const sampleSource = readFileSync(samplePath, "utf8");
    const emptied = Object.fromEntries(allSampleNames(sampleSource).map((name) => [name, ""]));

    await expect(execFileAsync(tsxProbe.path, [configPath], {
      cwd: packageRoot,
      env: {
        ...emptied,
        PATH: process.env.PATH,
        // The two genuinely required secrets. Everything else must tolerate "".
        ENCRYPTION_KEY: "0".repeat(64),
        AUTH_SECRET: "a".repeat(32),
      },
      encoding: "utf8",
      shell: tsxProbe.shell,
    })).resolves.toMatchObject({ stderr: "" });
  });

  /**
   * `AUTHZ_ENFORCE` is GONE and must stay gone. RBAC is enforced
   * unconditionally, so there is nothing to document and nothing to read — a
   * reintroduced flag is a reintroduced way to ship with authorization off,
   * which is exactly how `.env.example` once propagated `AUTHZ_ENFORCE=false`
   * into real deployments.
   */
  it("keeps the RBAC enforcement switch deleted, in code and in the sample", () => {
    const configSource = readFileSync(configPath, "utf8");
    const sampleSource = readFileSync(samplePath, "utf8");

    expect(directEnvironmentNames(configSource)).not.toContain("AUTHZ_ENFORCE");
    expect(documentedEnvironmentNames(sampleSource).has("AUTHZ_ENFORCE")).toBe(false);
  });
});
