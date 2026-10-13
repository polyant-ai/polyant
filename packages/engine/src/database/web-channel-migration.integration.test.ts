// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Migration 0091 on an existing install: every agent keeps its endpoint (a `web`
 * row, enabled), and a demo-agent nobody used is removed while a used or edited
 * one stays. The migration has already run on the test database, so the test
 * plants the rows an upgrade would find and replays the migration's SQL.
 *
 * Self-skips without a migrated database.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import { queryClient } from "./client.js";
import { resolveDatabaseAvailability } from "./test-db.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

const MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "migrations", "0091_web_channel.sql"),
  "utf8",
);

type Tx = TransactionSql;

class Rollback extends Error {}

/**
 * Run a test inside a transaction that is always rolled back.
 *
 * Step 2 of the migration writes a `web` row for EVERY agent in the database,
 * so a committed replay switched Web on for agents other suites had just
 * created with it off, in parallel workers. Rolled back, the replay is never
 * visible outside this transaction. SHARE on `instances` holds off other
 * workers' inserts and deletes of agents for the few milliseconds it lasts, so
 * the INSERT … SELECT cannot meet an agent deleted under it.
 */
async function inRolledBackTransaction(body: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await queryClient.begin(async (tx) => {
      await tx`LOCK TABLE instances IN SHARE MODE`;
      await body(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

async function replayMigration(tx: Tx): Promise<void> {
  for (const statement of MIGRATION.split("--> statement-breakpoint")) {
    await tx.unsafe(statement);
  }
}

async function plantAgent(tx: Tx, slug: string, authEnabled: boolean): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO instances (slug, name, auth_enabled, workspace_id)
    VALUES (${slug}, ${slug}, ${authEnabled}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
    RETURNING id`;
  return rows[0].id;
}

async function webRow(tx: Tx, id: string) {
  const rows = await tx<{ enabled: boolean }[]>`
    SELECT enabled FROM instance_channels WHERE instance_id = ${id} AND channel_type = 'web'`;
  return rows[0];
}

async function exists(tx: Tx, slug: string): Promise<boolean> {
  const rows = await tx`SELECT 1 FROM instances WHERE slug = ${slug}`;
  return rows.length > 0;
}

describe.skipIf(!DB_AVAILABLE)("migration 0091 — Web becomes a channel", () => {
  it("switches Web on for every existing agent and leaves auth_enabled as it was", async () => {
    await inRolledBackTransaction(async (tx) => {
      const open = await plantAgent(tx, "w91-open", false);
      const keyed = await plantAgent(tx, "w91-keyed", true);

      await replayMigration(tx);

      expect(await webRow(tx, open)).toEqual({ enabled: true });
      expect(await webRow(tx, keyed)).toEqual({ enabled: true });
      const auth = await tx<{ slug: string; auth_enabled: boolean }[]>`
        SELECT slug, auth_enabled FROM instances WHERE slug IN ('w91-open', 'w91-keyed')`;
      expect(Object.fromEntries(auth.map((r) => [r.slug, r.auth_enabled]))).toEqual({
        "w91-open": false,
        "w91-keyed": true,
      });
    });
  });

  it("is safe to replay: an agent switched off since stays off", async () => {
    await inRolledBackTransaction(async (tx) => {
      const id = await plantAgent(tx, "w91-open", true);
      await replayMigration(tx);
      await tx`UPDATE instance_channels SET enabled = false WHERE instance_id = ${id} AND channel_type = 'web'`;
      await replayMigration(tx);
      expect(await webRow(tx, id)).toEqual({ enabled: false });
    });
  });

  it("removes a demo-agent nobody used", async () => {
    await inRolledBackTransaction(async (tx) => {
      await plantAgent(tx, "demo-agent", false);
      await replayMigration(tx);
      expect(await exists(tx, "demo-agent")).toBe(false);
    });
  });

  it("keeps a demo-agent that has a conversation, and gives it Web on like any existing agent", async () => {
    await inRolledBackTransaction(async (tx) => {
      const id = await plantAgent(tx, "demo-agent", false);
      await tx`INSERT INTO conversations (conversation_id, instance_id) VALUES ('w91-conv', 'demo-agent')`;
      await replayMigration(tx);
      expect(await exists(tx, "demo-agent")).toBe(true);
      expect(await webRow(tx, id)).toEqual({ enabled: true });
    });
  });

  it("keeps a demo-agent that was edited after the seed", async () => {
    await inRolledBackTransaction(async (tx) => {
      // `now()` is the transaction's start time, so a later updated_at has to be
      // set explicitly for the row to read as edited.
      const id = await plantAgent(tx, "demo-agent", false);
      await tx`UPDATE instances SET name = 'Mine', updated_at = now() + interval '1 minute' WHERE id = ${id}`;
      await replayMigration(tx);
      expect(await exists(tx, "demo-agent")).toBe(true);
    });
  });
});
