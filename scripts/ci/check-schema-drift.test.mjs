// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { applyKnownDifferences, compareSnapshots, normalizeSql } from "./check-schema-drift.mjs";

function column(name, type, extra = {}) {
  return { name, type, primaryKey: false, notNull: false, ...extra };
}

function snapshot(tables, enums = {}) {
  return {
    tables: Object.fromEntries(
      tables.map((table) => [
        `public.${table.name}`,
        {
          schema: "",
          indexes: {},
          foreignKeys: {},
          uniqueConstraints: {},
          checkConstraints: {},
          compositePrimaryKeys: {},
          ...table,
          columns: Object.fromEntries(table.columns.map((c) => [c.name, c])),
        },
      ]),
    ),
    enums,
  };
}

const baseColumns = () => [
  column("id", "uuid", { primaryKey: true, notNull: true, default: "gen_random_uuid()" }),
  column("slug", "varchar(64)", { notNull: true }),
];

test("identical snapshots have no problems", () => {
  const schema = snapshot([{ name: "agents", columns: baseColumns() }]);
  assert.deepEqual(compareSnapshots(schema, snapshot([{ name: "agents", columns: baseColumns() }])), []);
});

test("a schema column with no migration is reported", () => {
  const schema = snapshot([{ name: "agents", columns: [...baseColumns(), column("title", "text")] }]);
  const database = snapshot([{ name: "agents", columns: baseColumns() }]);
  assert.deepEqual(
    compareSnapshots(schema, database).map((p) => p.key),
    ["column-only-in-schema:agents.title"],
  );
});

test("a migrated column the schema does not declare is reported", () => {
  const schema = snapshot([{ name: "agents", columns: baseColumns() }]);
  const database = snapshot([{ name: "agents", columns: [...baseColumns(), column("legacy", "text")] }]);
  assert.deepEqual(
    compareSnapshots(schema, database).map((p) => p.key),
    ["column-only-in-database:agents.legacy"],
  );
});

test("type, nullability and default differences are reported", () => {
  const schema = snapshot([
    { name: "agents", columns: [column("id", "uuid", { notNull: true }), column("kind", "varchar(32)", { default: "'a'" })] },
  ]);
  const database = snapshot([
    { name: "agents", columns: [column("id", "text"), column("kind", "varchar(32)", { default: "'b'::character varying" })] },
  ]);
  assert.deepEqual(
    compareSnapshots(schema, database).map((p) => p.key),
    ["column-type:agents.id", "column-nullability:agents.id", "column-default:agents.kind"],
  );
});

test("defaults and predicates compare after casts, quotes and parentheses are removed", () => {
  assert.equal(normalizeSql("'running'::character varying"), normalizeSql("'running'"));
  assert.equal(
    normalizeSql(`"jobs"."status" = 'running'`),
    normalizeSql("((status)::text = 'running'::text)"),
  );
});

test("missing tables are reported in both directions", () => {
  const schema = snapshot([{ name: "agents", columns: baseColumns() }]);
  const database = snapshot([{ name: "other", columns: baseColumns() }]);
  assert.deepEqual(
    compareSnapshots(schema, database).map((p) => p.key),
    ["table-only-in-schema:agents", "table-only-in-database:other"],
  );
});

test("indexes, foreign keys and checks the schema declares must exist; database extras are fine", () => {
  const index = {
    name: "idx_agents_slug",
    columns: [{ expression: "slug", isExpression: false }],
    isUnique: false,
  };
  const fk = { columnsFrom: ["owner_id"], tableTo: "users", columnsTo: ["id"], onDelete: "cascade", onUpdate: "no action" };
  const schema = snapshot([
    {
      name: "agents",
      columns: [...baseColumns(), column("owner_id", "uuid")],
      indexes: { idx_agents_slug: index },
      foreignKeys: { agents_owner_id_users_id_fk: { name: "agents_owner_id_users_id_fk", ...fk } },
      checkConstraints: { agents_slug_lower: { name: "agents_slug_lower", value: "slug = lower(slug)" } },
    },
  ]);
  const bare = snapshot([{ name: "agents", columns: [...baseColumns(), column("owner_id", "uuid")] }]);
  assert.deepEqual(
    compareSnapshots(schema, bare).map((p) => p.key),
    ["index-missing:agents.idx_agents_slug", "foreign-key-missing:agents.owner_id", "check-missing:agents.agents_slug_lower"],
  );

  const complete = snapshot([
    {
      name: "agents",
      columns: [...baseColumns(), column("owner_id", "uuid")],
      indexes: {
        idx_agents_slug: { ...index, columns: [{ expression: "slug", isExpression: false, opclass: "text_ops" }] },
        idx_sql_only: { name: "idx_sql_only", columns: [{ expression: "owner_id" }], isUnique: false, where: "(owner_id IS NOT NULL)" },
      },
      // The SQL names its foreign keys differently; the shape is what matters.
      foreignKeys: { agents_owner_id_fkey: { name: "agents_owner_id_fkey", schemaTo: "public", ...fk } },
      checkConstraints: {
        agents_slug_lower: { name: "agents_slug_lower", value: "((slug)::text = lower((slug)::text))" },
        agents_sql_only: { name: "agents_sql_only", value: "true" },
      },
    },
  ]);
  assert.deepEqual(compareSnapshots(schema, complete), []);
});

test("a unique index declared in the schema may be a unique constraint in the database", () => {
  const schema = snapshot([
    {
      name: "agents",
      columns: baseColumns(),
      indexes: { agents_slug_uniq: { name: "agents_slug_uniq", columns: [{ expression: "slug" }], isUnique: true } },
      uniqueConstraints: { agents_slug_unique: { name: "agents_slug_unique", columns: ["slug"] } },
    },
  ]);
  const database = snapshot([
    { name: "agents", columns: baseColumns(), uniqueConstraints: { agents_slug_uniq: { name: "agents_slug_uniq", columns: ["slug"] } } },
  ]);
  assert.deepEqual(compareSnapshots(schema, database), []);
});

test("enums must match value for value", () => {
  const schema = snapshot([], { "public.status": { name: "status", values: ["a", "b", "c"] } });
  const database = snapshot([], { "public.status": { name: "status", values: ["a", "b"] } });
  assert.deepEqual(compareSnapshots(schema, database).map((p) => p.key), ["enum-values:status"]);
});

test("known differences are accepted, and a known entry that matches nothing is stale", () => {
  const problems = [
    { key: "column-only-in-database:agents.search", message: "m1" },
    { key: "column-type:agents.id", message: "m2" },
  ];
  const known = [
    { key: "column-only-in-database:agents.search", reason: "generated" },
    { key: "column-default:agents.gone", reason: "fixed long ago" },
  ];
  const { unexpected, accepted, stale } = applyKnownDifferences(problems, known);
  assert.deepEqual(unexpected.map((p) => p.key), ["column-type:agents.id"]);
  assert.deepEqual(accepted.map((p) => p.key), ["column-only-in-database:agents.search"]);
  assert.deepEqual(stale.map((entry) => entry.key), ["column-default:agents.gone"]);
});
