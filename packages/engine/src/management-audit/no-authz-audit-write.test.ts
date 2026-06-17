// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AC guard (RBAC Stream 7): the EE `authz_audit_logs` table must have NO write
 * path in OSS. The schema is declared (so enabling EE later needs no migration),
 * but nothing in the OSS engine source may `insert(...)` into it. This test
 * fails the build the moment an OSS write path is introduced.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("authz_audit_logs has no OSS write path", () => {
  it("no OSS source inserts into authzAuditLogs", () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(ENGINE_SRC)) {
      const src = readFileSync(file, "utf8");
      // A write is an `insert(...)` whose argument is the authz audit table.
      if (/insert\s*\(\s*authzAuditLogs\b/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
