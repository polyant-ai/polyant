// SPDX-License-Identifier: AGPL-3.0-or-later

// Fails when the Drizzle schema and a database built from the migrations disagree.
//
// Migrations here are written by hand, so nothing ties a column added to a
// *.schema.ts file to the SQL that creates it: the code compiles, the unit tests
// mock the database, and the first query that touches the column fails in
// production. `drizzle-kit generate` and `drizzle-kit check` cannot catch it —
// there are no drizzle-kit snapshots to diff against — and a plain statement diff
// is useless because the SQL deliberately holds things the schema does not
// declare (CHECK constraints, partial indexes, generated search columns).
//
// So the check is structural and one-directional where the SQL is allowed to
// know more:
//   - tables and their columns must match in both directions, with type,
//     nullability and default;
//   - every index, foreign key, unique constraint, check constraint, composite
//     primary key and enum the schema declares must exist in the database;
//   - anything the database has beyond that (SQL-only constraints and indexes)
//     is accepted.
//
// Usage, against a database migrated with `npm run db:migrate`:
//   node --import tsx scripts/ci/check-schema-drift.mjs
// It reads DATABASE_URL, or builds the URL from the POSTGRES_* variables.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const engineDir = path.join(repoRoot, "packages", "engine");

// Differences the database is known to have on purpose, or that are tracked
// elsewhere. Each entry needs its reason; an entry that no longer matches
// anything is reported, so the list cannot rot.
export const KNOWN_DIFFERENCES = [
  {
    key: "column-only-in-database:conversation_messages.search_vector",
    reason: "generated tsvector column maintained in SQL for full-text search",
  },
  {
    key: "column-only-in-database:knowledge_chunks.content_tsv",
    reason: "generated tsvector column maintained in SQL for full-text search",
  },
];

/** Reduces an SQL fragment to a comparable form: no quotes, qualifiers, casts or parentheses. */
export function normalizeSql(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/"[^"]+"\./g, "")
    .replace(/"/g, "")
    .replace(/::[a-z_]+(?: varying| precision| with(?:out)? time zone)?(?:\(\d+\))?(?:\[\])?/gi, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tablesByName(snapshot) {
  const tables = new Map();
  for (const table of Object.values(snapshot.tables ?? {})) {
    tables.set(`${table.schema || "public"}.${table.name}`, table);
  }
  return tables;
}

function label(qualifiedName) {
  return qualifiedName.startsWith("public.") ? qualifiedName.slice("public.".length) : qualifiedName;
}

function columnsKey(columns) {
  return columns.join(",");
}

function indexShape(index) {
  return {
    columns: index.columns.map((column) => normalizeSql(column.expression)),
    unique: Boolean(index.isUnique),
    where: normalizeSql(index.where),
  };
}

function foreignKeyShape(fk) {
  return [
    columnsKey(fk.columnsFrom),
    fk.schemaTo && fk.schemaTo !== "public" ? `${fk.schemaTo}.${fk.tableTo}` : fk.tableTo,
    columnsKey(fk.columnsTo),
    fk.onDelete ?? "no action",
    fk.onUpdate ?? "no action",
  ].join("|");
}

/**
 * Compares the snapshot generated from the schema files with the one pulled
 * from the database. Returns the problems as `{ key, message }`; `key` is what
 * KNOWN_DIFFERENCES matches against.
 */
export function compareSnapshots(declared, database) {
  const problems = [];
  const report = (key, message) => problems.push({ key, message });

  const declaredTables = tablesByName(declared);
  const databaseTables = tablesByName(database);

  for (const name of declaredTables.keys()) {
    if (!databaseTables.has(name)) {
      report(`table-only-in-schema:${label(name)}`, `table ${label(name)} is declared in the schema but no migration creates it`);
    }
  }
  for (const name of databaseTables.keys()) {
    if (!declaredTables.has(name)) {
      report(`table-only-in-database:${label(name)}`, `table ${label(name)} exists in the database but no schema file declares it`);
    }
  }

  for (const [name, schemaTable] of declaredTables) {
    const dbTable = databaseTables.get(name);
    if (!dbTable) continue;
    const table = label(name);

    for (const column of Object.values(schemaTable.columns)) {
      const dbColumn = dbTable.columns[column.name];
      const where = `${table}.${column.name}`;
      if (!dbColumn) {
        report(`column-only-in-schema:${where}`, `column ${where} is declared in the schema but no migration creates it`);
        continue;
      }
      if (column.type !== dbColumn.type) {
        report(`column-type:${where}`, `column ${where} is ${column.type} in the schema and ${dbColumn.type} in the database`);
      }
      if (Boolean(column.notNull) !== Boolean(dbColumn.notNull)) {
        const nullable = (notNull) => (notNull ? "NOT NULL" : "nullable");
        report(
          `column-nullability:${where}`,
          `column ${where} is ${nullable(column.notNull)} in the schema and ${nullable(dbColumn.notNull)} in the database`,
        );
      }
      if (normalizeSql(column.default) !== normalizeSql(dbColumn.default)) {
        report(
          `column-default:${where}`,
          `column ${where} defaults to ${column.default ?? "nothing"} in the schema and ${dbColumn.default ?? "nothing"} in the database`,
        );
      }
    }
    for (const dbColumn of Object.values(dbTable.columns)) {
      if (!schemaTable.columns[dbColumn.name]) {
        const where = `${table}.${dbColumn.name}`;
        report(`column-only-in-database:${where}`, `column ${where} exists in the database but the schema does not declare it`);
      }
    }

    for (const index of Object.values(schemaTable.indexes ?? {})) {
      const dbIndex = dbTable.indexes?.[index.name];
      const where = `${table}.${index.name}`;
      // A unique index the SQL created as a UNIQUE constraint is the same
      // thing: Postgres backs the constraint with an index of that name.
      const dbConstraint = dbTable.uniqueConstraints?.[index.name];
      if (!dbIndex && dbConstraint && index.isUnique && !index.where) {
        const columns = indexShape(index).columns;
        if (columnsKey(columns) !== columnsKey(dbConstraint.columns)) {
          report(
            `index-shape:${where}`,
            `index ${where} covers (${columnsKey(columns)}) in the schema and (${columnsKey(dbConstraint.columns)}) in the database`,
          );
        }
        continue;
      }
      if (!dbIndex) {
        report(`index-missing:${where}`, `index ${where} is declared in the schema but no migration creates it`);
        continue;
      }
      if (JSON.stringify(indexShape(index)) !== JSON.stringify(indexShape(dbIndex))) {
        report(
          `index-shape:${where}`,
          `index ${where} differs: schema ${JSON.stringify(indexShape(index))}, database ${JSON.stringify(indexShape(dbIndex))}`,
        );
      }
    }

    const dbForeignKeys = new Set(Object.values(dbTable.foreignKeys ?? {}).map(foreignKeyShape));
    for (const fk of Object.values(schemaTable.foreignKeys ?? {})) {
      if (!dbForeignKeys.has(foreignKeyShape(fk))) {
        report(
          `foreign-key-missing:${table}.${columnsKey(fk.columnsFrom)}`,
          `foreign key ${table}(${columnsKey(fk.columnsFrom)}) -> ${fk.tableTo}(${columnsKey(fk.columnsTo)}) on delete ${fk.onDelete ?? "no action"} is declared in the schema but not in the database`,
        );
      }
    }

    // A unique constraint may live in the database as a constraint or as a
    // unique index on the same columns; either enforces it.
    const dbUniqueColumns = new Set([
      ...Object.values(dbTable.uniqueConstraints ?? {}).map((unique) => columnsKey(unique.columns)),
      ...Object.values(dbTable.indexes ?? {})
        .filter((index) => index.isUnique && !index.where)
        .map((index) => columnsKey(indexShape(index).columns)),
    ]);
    for (const unique of Object.values(schemaTable.uniqueConstraints ?? {})) {
      if (!dbUniqueColumns.has(columnsKey(unique.columns))) {
        report(
          `unique-missing:${table}.${columnsKey(unique.columns)}`,
          `unique constraint on ${table}(${columnsKey(unique.columns)}) is declared in the schema but not in the database`,
        );
      }
    }

    for (const check of Object.values(schemaTable.checkConstraints ?? {})) {
      if (!dbTable.checkConstraints?.[check.name]) {
        report(`check-missing:${table}.${check.name}`, `check constraint ${table}.${check.name} is declared in the schema but not in the database`);
      }
    }

    const dbPrimaryKeys = new Set([
      ...Object.values(dbTable.compositePrimaryKeys ?? {}).map((pk) => columnsKey(pk.columns)),
      columnsKey(Object.values(dbTable.columns).filter((column) => column.primaryKey).map((column) => column.name)),
    ]);
    for (const pk of Object.values(schemaTable.compositePrimaryKeys ?? {})) {
      if (!dbPrimaryKeys.has(columnsKey(pk.columns))) {
        report(`primary-key:${table}`, `primary key (${columnsKey(pk.columns)}) on ${table} is declared in the schema but not in the database`);
      }
    }
    const declaredColumnPk = Object.values(schemaTable.columns).filter((column) => column.primaryKey).map((column) => column.name);
    if (declaredColumnPk.length > 0 && !dbPrimaryKeys.has(columnsKey(declaredColumnPk))) {
      report(`primary-key:${table}`, `primary key (${columnsKey(declaredColumnPk)}) on ${table} is declared in the schema but not in the database`);
    }
  }

  for (const [name, enumType] of Object.entries(declared.enums ?? {})) {
    const dbEnum = database.enums?.[name];
    if (!dbEnum) {
      report(`enum-missing:${label(name)}`, `enum ${label(name)} is declared in the schema but no migration creates it`);
    } else if (columnsKey(enumType.values) !== columnsKey(dbEnum.values)) {
      report(
        `enum-values:${label(name)}`,
        `enum ${label(name)} is (${enumType.values.join(", ")}) in the schema and (${dbEnum.values.join(", ")}) in the database`,
      );
    }
  }

  return problems;
}

/** Splits problems into the ones that fail the check and known entries that matched nothing. */
export function applyKnownDifferences(problems, known = KNOWN_DIFFERENCES) {
  const knownKeys = new Set(known.map((entry) => entry.key));
  const seen = new Set(problems.map((problem) => problem.key));
  return {
    unexpected: problems.filter((problem) => !knownKeys.has(problem.key)),
    accepted: problems.filter((problem) => knownKeys.has(problem.key)),
    stale: known.filter((entry) => !seen.has(entry.key)),
  };
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = process.env;
  const credentials = `${encodeURIComponent(env.POSTGRES_USER ?? "polyant")}:${encodeURIComponent(env.POSTGRES_PASSWORD ?? "")}`;
  return `postgresql://${credentials}@${env.POSTGRES_HOST ?? "localhost"}:${env.POSTGRES_PORT ?? "5432"}/${env.POSTGRES_DB ?? "polyant"}`;
}

function pullDatabaseSnapshot(url) {
  const outDir = mkdtempSync(path.join(tmpdir(), "schema-drift-"));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "node_modules", "drizzle-kit", "bin.cjs"), "pull", "--dialect", "postgresql", "--url", url, "--out", outDir],
      { cwd: engineDir, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`drizzle-kit pull failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    return JSON.parse(readFileSync(path.join(outDir, "meta", "0000_snapshot.json"), "utf8"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function declaredSnapshot() {
  const { generateDrizzleJson } = await import("drizzle-kit/api");
  // drizzle.config.ts lists every schema file; a guardrail test holds that list
  // to the source tree, so it is the inventory to load here too.
  const config = (await import(pathToFileURL(path.join(engineDir, "drizzle.config.ts")).href)).default;
  const exports = {};
  for (const file of config.schema) {
    Object.assign(exports, await import(pathToFileURL(path.resolve(engineDir, file)).href));
  }
  return generateDrizzleJson(exports);
}

async function main() {
  const declared = await declaredSnapshot();
  const database = pullDatabaseSnapshot(databaseUrl());
  const { unexpected, accepted, stale } = applyKnownDifferences(compareSnapshots(declared, database));

  for (const problem of accepted) {
    const entry = KNOWN_DIFFERENCES.find((known) => known.key === problem.key);
    console.log(`known: ${problem.message} (${entry.reason})`);
  }
  for (const entry of stale) {
    console.log(`stale known difference, remove it from KNOWN_DIFFERENCES: ${entry.key}`);
  }
  if (unexpected.length > 0) {
    console.error(`\nThe Drizzle schema and the migrated database disagree (${unexpected.length}):`);
    for (const problem of unexpected) console.error(`  - ${problem.message}`);
    console.error("\nAdd a migration under packages/engine/src/database/migrations (with its _journal.json entry) or fix the schema file.");
  }
  if (unexpected.length > 0 || stale.length > 0) process.exit(1);
  console.log(`Schema and migrations agree (${Object.keys(declared.tables).length} tables).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
  // The schema modules may open database pools on import; do not wait for them.
  process.exit(process.exitCode ?? 0);
}
