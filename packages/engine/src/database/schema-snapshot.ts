// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateDrizzleJson, generateMigration, type DrizzleSnapshotJSON } from "drizzle-kit/api";

/**
 * The Drizzle schema snapshot `npm run db:generate` diffs the schema files against.
 *
 * Migrations here are written by hand, and without a snapshot drizzle-kit compared
 * the schema with nothing and generated one migration recreating every table.
 * `migrations/meta` therefore holds exactly one snapshot: the schema as of the
 * latest migration. A guardrail test fails when the schema files and the
 * snapshot disagree; `npm run db:snapshot` rewrites it.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const META = join(SRC, "database/migrations/meta");

/** The source files that declare a table, as `drizzle.config.ts` lists them. */
function schemaFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .filter((f) => /\bpgTable\(/.test(readFileSync(join(SRC, f), "utf8")))
    .sort();
}

/** The snapshot of the schema files as they are now. */
export async function currentSchemaSnapshot(): Promise<DrizzleSnapshotJSON> {
  const imports: Record<string, unknown> = {};
  for (const file of schemaFiles()) {
    const module = (await import(pathToFileURL(join(SRC, file)).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) imports[`${file}:${name}`] = value;
  }
  return generateDrizzleJson(imports);
}

function snapshotFiles(): string[] {
  return readdirSync(META).filter((f) => f.endsWith("_snapshot.json")).sort();
}

/** The committed snapshot, or undefined when there is none. */
export function committedSchemaSnapshot(): DrizzleSnapshotJSON | undefined {
  const last = snapshotFiles().at(-1);
  return last ? (JSON.parse(readFileSync(join(META, last), "utf8")) as DrizzleSnapshotJSON) : undefined;
}

/** The statements `db:generate` would write for the schema files today. */
export async function pendingSchemaStatements(): Promise<string[]> {
  const committed = committedSchemaSnapshot();
  if (!committed) throw new Error(`No schema snapshot in ${relative(process.cwd(), META)}`);
  return generateMigration(committed, await currentSchemaSnapshot());
}

/** Replace the committed snapshot with the schema files' current one, named after the latest migration. */
export async function writeSchemaSnapshot(): Promise<string> {
  const journal = JSON.parse(readFileSync(join(META, "_journal.json"), "utf8")) as { entries: Array<{ idx: number }> };
  const name = `${String(journal.entries.at(-1)!.idx).padStart(4, "0")}_snapshot.json`;
  for (const old of snapshotFiles()) rmSync(join(META, old));
  writeFileSync(join(META, name), JSON.stringify(await currentSchemaSnapshot(), null, 2) + "\n");
  return name;
}
