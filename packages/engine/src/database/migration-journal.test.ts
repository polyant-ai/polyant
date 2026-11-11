// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");
const journal = JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

/**
 * Integrity guards on the migration journal.
 *
 * drizzle's migrator decides what to apply by comparing each entry's `when`
 * against the newest already-applied timestamp — NOT by file name. So a journal
 * whose timestamps are out of order is not cosmetic: an entry that sorts before
 * an already-applied one is skipped SILENTLY, with no error and no missing-file
 * warning. The `0074` migration was renumbered by hand to sit after MCP, which
 * is exactly the manoeuvre that produces this, so it gets a test rather than a
 * convention.
 */
describe("migration journal", () => {
  it("should_keep_when_timestamps_strictly_increasing", () => {
    const outOfOrder = journal.entries
      .map((entry, i) => ({ entry, prev: journal.entries[i - 1] }))
      .filter(({ entry, prev }) => prev && entry.when <= prev.when)
      .map(({ entry, prev }) => `${entry.tag} (when=${entry.when}) does not come after ${prev!.tag} (when=${prev!.when})`);

    expect(outOfOrder).toEqual([]);
  });

  it("should_keep_idx_contiguous_and_ordered", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it("should_have_a_sql_file_for_every_entry_and_an_entry_for_every_file", () => {
    const tagged = new Set(journal.entries.map((e) => e.tag));
    const missingFiles = journal.entries
      .map((e) => `${e.tag}.sql`)
      .filter((file) => !existsSync(resolve(migrationsDir, file)));
    const orphanFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => !tagged.has(f.replace(/\.sql$/, "")));

    expect({ missingFiles, orphanFiles }).toEqual({ missingFiles: [], orphanFiles: [] });
  });
});

/**
 * Tables every turn or every scheduler tick writes or reads, the only list of them.
 * ALTER TABLE takes an ACCESS EXCLUSIVE lock, which stops reads too, and the runner
 * applies a migration in one transaction: a lock taken on one of these is held
 * while the same file waits for the next one, and for any backfill it runs.
 */
const HOT_TABLES = new Set([
  "ai_logs",
  "model_exchanges",
  "hook_executions",
  "pipeline_traces",
  "tool_audit_logs",
  "conversations",
  "conversation_messages",
  "conversation_state",
  "memories",
  "event_backlog",
  "webhook_deliveries",
  "scheduled_tasks",
  "scheduled_task_runs",
  "work_leases",
]);

/**
 * Shipped before the rule existed. Applied migrations are never rewritten (the
 * runner decides by `when`), so they stay as they are; nothing new joins this list.
 */
const GRANDFATHERED_LOCK_SCOPE = new Set([
  "0003_analytics_enhancements.sql",
  "0025_timestamp_to_timestamptz.sql",
  "0038_reasoning_and_steps.sql",
  "0086_conversation_message_counters.sql",
  "0117_conversation_message_seq.sql",
  "0118_lock_hot_tables_last.sql",
  "0121_request_path.sql",
]);

const TABLE_NAME = String.raw`((?:"?\w+"?\.)?"?\w+"?)`;
const tableName = (raw: string) => raw.replace(/"/g, "").split(".").pop()!.toLowerCase();

/** What a migration file locks too broadly: the hot tables it alters, and the ones it also backfills. */
function lockScopeViolations(sqlText: string): string[] {
  const code = sqlText.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const altered = new Set(
    [...code.matchAll(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_NAME}`, "gi"))]
      .map((m) => tableName(m[1])),
  );
  const updated = new Set(
    [...code.matchAll(new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${TABLE_NAME}`, "gi"))].map((m) => tableName(m[1])),
  );
  const hotAltered = [...altered].filter((t) => HOT_TABLES.has(t)).sort();
  const violations: string[] = [];
  if (hotAltered.length > 1) violations.push(`alters ${hotAltered.length} hot tables (${hotAltered.join(", ")})`);
  for (const t of hotAltered) if (updated.has(t)) violations.push(`alters and backfills hot table ${t}`);
  return violations;
}

describe("migration lock scope", () => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const scopeOf = (file: string) => lockScopeViolations(readFileSync(resolve(migrationsDir, file), "utf8"));

  it("finds the migrations to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("alters at most one hot table per migration, and never backfills a hot table it alters", () => {
    const offenders = files
      .filter((f) => !GRANDFATHERED_LOCK_SCOPE.has(f))
      .flatMap((f) => scopeOf(f).map((v) => `${f}: ${v}; split it into one migration per hot table, backfill in a later one`));
    expect(offenders).toEqual([]);
  });

  it("grandfathers only shipped migrations that still break the rule", () => {
    const stale = [...GRANDFATHERED_LOCK_SCOPE].filter((f) => !files.includes(f) || scopeOf(f).length === 0);
    expect(stale).toEqual([]);
  });

  it("recognises both shapes, quoted or not", () => {
    expect(lockScopeViolations(`ALTER TABLE "ai_logs" ADD COLUMN x int;\nALTER TABLE public.hook_executions ADD COLUMN y int;`))
      .toEqual(["alters 2 hot tables (ai_logs, hook_executions)"]);
    expect(lockScopeViolations(`ALTER TABLE conversations ADD COLUMN n int;\nUPDATE "conversations" SET n = 0;`))
      .toEqual(["alters and backfills hot table conversations"]);
    expect(lockScopeViolations(`-- ALTER TABLE ai_logs\nALTER TABLE "event_backlog" ADD COLUMN a int;\nUPDATE instances SET x = 1;`))
      .toEqual([]);
  });
});
