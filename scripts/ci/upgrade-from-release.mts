// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Upgrades a database built by the previous release and checks that nothing
 * was lost: what an installation does when it moves to this version.
 *
 *   npx tsx scripts/ci/upgrade-from-release.mts [--from <tag>]
 *
 * 1. Creates an empty database (UPGRADE_DB_NAME, default polyant_upgrade) on
 *    the server POSTGRES_* names, applies the migrations of the previous
 *    release tag, and fills it with that tag's e2e seeds (plus this version's
 *    panel seed, when the old schema accepts it).
 * 2. Counts the rows of every table.
 * 3. Applies this version's migrations with the same runner the engine uses.
 * 4. Fails when a migration of this version was not recorded as applied
 *    (drizzle skips entries under its watermark and still reports success),
 *    or when a table lost rows or disappeared without a migration of this
 *    version deleting from or dropping it.
 *
 * The previous release is the newest tag of this edition (vX.Y.Z for open
 * source, vX.Y.Z-ee for Enterprise) that is not HEAD itself.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { readMigrations, runMigrationsLocked } from "../../packages/engine/src/database/run-migrations.js";

const ROOT = resolve(import.meta.dirname, "../..");
const MIGRATIONS = "packages/engine/src/database/migrations";
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function previousTag(): string {
  const fromArg = process.argv.indexOf("--from");
  if (fromArg !== -1 && process.argv[fromArg + 1]) return process.argv[fromArg + 1];
  const enterprise = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).name === "polyant-enterprise";
  const pattern = enterprise ? /^v\d+\.\d+\.\d+-ee$/ : /^v\d+\.\d+\.\d+$/;
  const head = git("rev-parse", "HEAD");
  const tag = git("tag", "--list", "v*", "--sort=-v:refname")
    .split("\n")
    .find((t) => pattern.test(t) && git("rev-list", "-n", "1", t) !== head);
  if (!tag) throw new Error(`no previous ${enterprise ? "Enterprise" : "open-source"} release tag found (fetch the tags)`);
  return tag;
}

/** Extracts `paths` of `tag` under `dir`, inside the repository so imports resolve its node_modules. */
function extract(tag: string, dir: string, paths: string[]): void {
  mkdirSync(dir, { recursive: true });
  const present = paths.filter((p) => git("ls-tree", "--name-only", tag, p) !== "");
  const archive = execFileSync("git", ["archive", tag, ...present], { cwd: ROOT });
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
}

function databaseUrl(database: string): string {
  const e = process.env;
  const password = encodeURIComponent(e.POSTGRES_PASSWORD ?? "polyant");
  return `postgresql://${e.POSTGRES_USER ?? "polyant"}:${password}@${e.POSTGRES_HOST ?? "localhost"}:${e.POSTGRES_PORT ?? "5432"}/${database}`;
}

async function rowCounts(sql: postgres.Sql): Promise<Map<string, number>> {
  const tables = await sql<{ name: string }[]>`
    SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS name
    FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
  const counts = new Map<string, number>();
  for (const { name } of tables) {
    const [row] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${name}`);
    counts.set(name.replace(/^public\./, "").replaceAll('"', ""), row.n);
  }
  return counts;
}

/** Tables this version's own migrations delete from, truncate or drop: losing rows there is intended. */
function touchedByNewMigrations(oldCount: number): Set<string> {
  const touched = new Set<string>();
  for (const m of readMigrations(join(ROOT, MIGRATIONS)).slice(oldCount)) {
    const text = m.statements.join("\n");
    for (const match of text.matchAll(/\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+"?([a-z_]+)"?/gi)) {
      touched.add(match[1].toLowerCase());
    }
  }
  return touched;
}

async function main(): Promise<void> {
  const tag = previousTag();
  const dbName = process.env.UPGRADE_DB_NAME ?? "polyant_upgrade";
  if (!/^[a-z][a-z0-9_]*$/.test(dbName)) throw new Error(`UPGRADE_DB_NAME must be a plain identifier, got "${dbName}"`);
  const work = join(ROOT, "packages/web/e2e/.upgrade", tag);
  rmSync(work, { recursive: true, force: true });
  extract(tag, work, [MIGRATIONS, "packages/web/e2e/setup"]);
  console.log(`Upgrading from ${tag}`);

  const admin = postgres(databaseUrl("postgres"), { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const url = databaseUrl(dbName);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const oldFolder = join(work, MIGRATIONS);
    const oldCount = readMigrations(oldFolder).length;
    await runMigrationsLocked(sql, oldFolder);

    // The release's own seeds, against its own schema.
    const seedDir = join(work, "packages/web/e2e/setup");
    const seeds = existsSync(seedDir) ? readdirSync(seedDir).filter((f) => /^seed-.*\.ts$/.test(f)).sort() : [];
    for (const file of seeds) {
      const module = (await import(pathToFileURL(join(seedDir, file)).href)) as Record<string, unknown>;
      for (const [name, fn] of Object.entries(module)) {
        if (name.startsWith("seed") && typeof fn === "function") await (fn as (u: string) => Promise<void>)(url);
      }
    }
    if (!seeds.includes("seed-panel.ts")) {
      // Releases before the panel seed have only users and workspaces; add
      // this version's history (agent, conversations, model calls) if the old
      // schema takes it, so the upgrade carries real rows.
      try {
        const { seedPanel } = await import("../../packages/web/e2e/setup/seed-panel.js");
        await seedPanel(url);
      } catch (err) {
        console.warn(`The panel seed does not fit ${tag}'s schema; upgrading with its own seeds only: ${String(err)}`);
      }
    }

    const before = await rowCounts(sql);
    const seeded = [...before.values()].reduce((a, b) => a + b, 0);
    if (seeded === 0) throw new Error("the old database holds no rows: the upgrade would prove nothing");

    const current = readMigrations(join(ROOT, MIGRATIONS));
    await runMigrationsLocked(sql, join(ROOT, MIGRATIONS));

    const failures: string[] = [];
    const [{ n: applied }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    if (applied !== current.length) {
      failures.push(`${applied} migrations recorded, ${current.length} in the journal: some were skipped`);
    }
    const after = await rowCounts(sql);
    const intended = touchedByNewMigrations(oldCount);
    for (const [table, count] of before) {
      if (intended.has(table)) continue;
      if (!after.has(table)) failures.push(`table ${table} disappeared`);
      else if ((after.get(table) ?? 0) < count) failures.push(`table ${table} went from ${count} rows to ${after.get(table)}`);
    }

    console.log(`${tag} schema (${oldCount} migrations) with ${seeded} rows → ${current.length} migrations.`);
    if (failures.length > 0) {
      for (const f of failures) console.error(`::error::${f}`);
      process.exitCode = 1;
    } else {
      console.log("Upgrade passed: every migration applied, no rows lost.");
    }
  } finally {
    await sql.end();
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
