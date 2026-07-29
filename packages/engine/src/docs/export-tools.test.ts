// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportToolCatalog } from "./export-tools.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsxPath = resolve(packageRoot, "../../node_modules/.bin/tsx");
const exporterPath = resolve(packageRoot, "src/docs/export-tools.ts");
const netMocks = vi.hoisted(() => ({ createConnection: vi.fn() }));

vi.mock("net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("net")>();
  return {
    ...actual,
    default: { ...actual, createConnection: netMocks.createConnection },
  };
});

const envKeys = ["ENCRYPTION_KEY", "AUTH_SECRET", "DATABASE_URL"] as const;
const originalEnv = new Map<string, string | undefined>();

describe("exportToolCatalog", () => {
  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("exports the real tool catalog without booting Nest or connecting to the database", async () => {
    const nestCreateSpy = vi.spyOn(NestFactory, "create");

    const catalog = await exportToolCatalog();

    expect(process.env.ENCRYPTION_KEY).toBe("0".repeat(64));
    expect(process.env.AUTH_SECRET).toBe("a".repeat(32));
    expect(process.env.DATABASE_URL).toBe("postgresql://localhost:5432/polyant_enterprise");
    expect(catalog.tools).not.toHaveLength(0);
    for (const tool of catalog.tools) {
      expect(tool.name).toEqual(expect.any(String));
      expect(tool.description).toEqual(expect.any(String));
      expect(tool.category).toEqual(expect.any(String));
    }
    expect(catalog.tools.some((tool) => tool.name === "spawnTask")).toBe(false);
    expect(nestCreateSpy).not.toHaveBeenCalled();
    expect(netMocks.createConnection).not.toHaveBeenCalled();
  });

  it("writes only pretty JSON plus a newline to stdout when run as a CLI", async () => {
    const cliEnv = { ...process.env };
    for (const key of envKeys) delete cliEnv[key];

    const { stdout, stderr } = await execFileAsync(tsxPath, [exporterPath], {
      cwd: packageRoot,
      env: cliEnv,
      encoding: "utf8",
    });
    const catalog = JSON.parse(stdout);

    expect(stdout).toBe(`${JSON.stringify(catalog, null, 2)}\n`);
    expect(stderr).toBe("");
  });
});
