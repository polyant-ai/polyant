// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { instances } from "./schema.js";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../database/migrations");
const migrationPath = resolve(migrationsDir, "0082_agent_capability_defaults.sql");

describe("new agent capability defaults", () => {
  it("keeps credential-dependent capabilities disabled until requested", () => {
    expect(instances.memoryEnabled.default).toBe(false);
    expect(instances.sttProvider.default).toBe("disabled");
  });

  it("changes database defaults without rewriting existing agents", () => {
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("ALTER COLUMN \"memory_enabled\" SET DEFAULT false");
    expect(sql).toContain("ALTER COLUMN \"stt_provider\" SET DEFAULT 'disabled'");
    expect(sql).not.toMatch(/\bUPDATE\s+"?instances"?/i);
  });
});
