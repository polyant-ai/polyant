// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Guardrail over the two ways a `TenantScope` can be wrong even though it
 * type-checks.
 *
 * The brand makes a scope unforgeable by shape: it can only come from a
 * constructor. That closes "an object literal is a scope" and leaves exactly
 * two holes, and this test is both of them:
 *
 *   1. A scope built from an UNVERIFIED id. `orgScope(user.orgId)` compiles and
 *      reads like the right thing, but `instances.orgId` in the JWT is a
 *      LANDING PREFERENCE, not a scope (CLAUDE.md → Enterprise): it says which
 *      organization the caller is shown first, never which one they may act in.
 *      Same for anything off the request — `query`, `body`, `params`, headers.
 *      The sanctioned path is to RESOLVE the organization first
 *      (`resolvePrincipalOrgId`, and in the enterprise build the workspace
 *      resolvers), then build the scope from what came back.
 *
 *   2. The cross-tenant scope, which is the one variant that constrains
 *      nothing. Every use is a place where a query answers across every
 *      tenant, so the set of them is allow-listed here with the reason it is
 *      allowed, and the count can only go DOWN. A rise is either a new
 *      unbounded read or a caller that gave up resolving its tenant, and both
 *      deserve to be argued for in a diff rather than noticed later.
 *
 * The subjects are derived by walking the source tree, never from a
 * hand-maintained list of files: a list is a thing a new file escapes from in
 * silence, which is exactly when a guard should fire.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The constructors. `scope-filter.ts` itself is where they are defined. */
const CONSTRUCTORS = [
  "orgScope",
  "orgWorkspacesScope",
  "workspaceScope",
  "workspaceSetScope",
] as const;

/**
 * Expressions a scope may NOT be built from: a token claim, or anything the
 * caller sent. `user?.orgId` included — the `?.` is not what makes it safe.
 */
const UNVERIFIED = [
  String.raw`(?:user|principal|caller|actor)\s*\??\.\s*orgId`,
  String.raw`req(?:uest)?\s*\??\.\s*(?:query|body|params|headers)`,
  String.raw`\b(?:query|body|params|headers)\s*\.\s*\w*[oO]rg`,
] as const;

/**
 * Where the cross-tenant scope may be built, and why. Each of these has NO
 * principal to resolve a tenant from; the reason travels in the call as well,
 * so this list and the code cannot drift apart silently.
 */
const CROSS_TENANT_ALLOWED: Readonly<Record<string, string>> = {
  "embeddings-gateway/embedding-reset.service.ts":
    "a provider switch wipes one agent's rows, keyed by slug, with no request behind it",
  "hooks/functions/conversation-reset.hook.ts":
    "a hook runs outside any request; it checks whether an archive id is taken",
  "memory/hybrid-search.ts":
    "runs inside a turn, and the agent slug already pins one tenant",
};

/** Non-vacuity floor: the cap means nothing if the scan found nothing. */
const MIN_FILES_SCANNED = 100;

/**
 * The cap can only go DOWN. It is the number of files allowed to build the
 * cross-tenant scope, and it equals the allow-list — kept as its own number so
 * that shrinking the list without shrinking the cap still reads as progress.
 */
const CROSS_TENANT_FILE_CAP = 3;

interface Occurrence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Code lines only: a docblock that NAMES a constructor is not a call. */
function codeLines(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlockComment = false;
  source.split("\n").forEach((raw, i) => {
    const text = raw.trim();
    if (inBlockComment) {
      if (text.includes("*/")) inBlockComment = false;
      return;
    }
    if (text.startsWith("/*")) {
      if (!text.includes("*/")) inBlockComment = true;
      return;
    }
    if (text.startsWith("//") || text.startsWith("*")) return;
    out.push({ line: i + 1, text });
  });
  return out;
}

const FILES = collectSourceFiles(ENGINE_SRC).filter(
  (f) => !f.endsWith(join("authz", "scope-filter.ts")),
);

function scan(pattern: RegExp): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of FILES) {
    for (const { line, text } of codeLines(readFileSync(file, "utf8"))) {
      if (pattern.test(text)) {
        found.push({ file: relative(ENGINE_SRC, file).split(sep).join("/"), line, text });
      }
    }
  }
  return found;
}

describe("TenantScope producers", () => {
  it("scans a non-trivial slice of the engine", () => {
    expect(FILES.length, "no source files scanned — did the tree move?").toBeGreaterThan(
      MIN_FILES_SCANNED,
    );
  });

  it("never builds a scope from a token claim or from request input", () => {
    const constructor = CONSTRUCTORS.join("|");
    const offenders = UNVERIFIED.flatMap((unverified) =>
      scan(new RegExp(String.raw`\b(?:${constructor})\s*\(\s*[^)]*${unverified}`)),
    );
    expect(
      offenders.map((o) => `${o.file}:${o.line} — ${o.text}`),
      "a tenant scope must be built from a RESOLVED organization, never from a claim or from what the caller sent",
    ).toEqual([]);
  });

  it("builds the cross-tenant scope only where there is no tenant to resolve", () => {
    const uses = scan(/\ballTenantsScope\s*\(/);
    const files = [...new Set(uses.map((u) => u.file))].sort();

    const unlisted = files.filter((f) => !(f in CROSS_TENANT_ALLOWED));
    expect(
      unlisted,
      "a new cross-tenant read: add it to CROSS_TENANT_ALLOWED with the reason it has no tenant, or resolve one",
    ).toEqual([]);

    // The floor: if the scan stops finding the known uses, the rule above is
    // passing for the wrong reason.
    expect(files.length, "no cross-tenant use found — the scan is broken").toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(CROSS_TENANT_FILE_CAP);
  });

  it("keeps the allow-list honest: every entry still builds one", () => {
    const files = new Set(scan(/\ballTenantsScope\s*\(/).map((u) => u.file));
    const stale = Object.keys(CROSS_TENANT_ALLOWED).filter((f) => !files.has(f));
    expect(
      stale,
      "these files no longer build a cross-tenant scope — drop them from the list and lower the cap",
    ).toEqual([]);
  });
});
