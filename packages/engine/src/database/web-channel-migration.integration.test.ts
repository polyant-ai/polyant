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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "./client.js";
import { resolveDatabaseAvailability } from "./test-db.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

const MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "migrations", "0091_web_channel.sql"),
  "utf8",
);

/**
 * Step 2 of the migration inserts a `web` row for EVERY agent in the database,
 * so a suite in another worker deleting its own agent between the SELECT and
 * the foreign-key check fails this replay. SHARE mode holds off writes to
 * `instances` for the few milliseconds the replay takes, and nothing else.
 */
async function replayMigration(): Promise<void> {
  await queryClient.begin(async (tx) => {
    await tx`LOCK TABLE instances IN SHARE MODE`;
    for (const statement of MIGRATION.split("--> statement-breakpoint")) {
      await tx.unsafe(statement);
    }
  });
}

async function plantAgent(slug: string, authEnabled: boolean): Promise<string> {
  const rows = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, auth_enabled, workspace_id)
    VALUES (${slug}, ${slug}, ${authEnabled}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
    RETURNING id`;
  return rows[0].id;
}

async function webRow(id: string) {
  const rows = await queryClient<{ enabled: boolean }[]>`
    SELECT enabled FROM instance_channels WHERE instance_id = ${id} AND channel_type = 'web'`;
  return rows[0];
}

async function exists(slug: string): Promise<boolean> {
  const rows = await queryClient`SELECT 1 FROM instances WHERE slug = ${slug}`;
  return rows.length > 0;
}

describe.skipIf(!DB_AVAILABLE)("migration 0091 — Web becomes a channel", () => {
  const slugs = ["w91-open", "w91-keyed", "demo-agent"];

  const cleanup = async () => {
    await queryClient`DELETE FROM conversations WHERE instance_id = 'demo-agent'`;
    await queryClient`DELETE FROM instances WHERE slug IN ${queryClient(slugs)}`;
  };
  beforeEach(cleanup);
  afterEach(cleanup);

  it("switches Web on for every existing agent and leaves auth_enabled as it was", async () => {
    const open = await plantAgent("w91-open", false);
    const keyed = await plantAgent("w91-keyed", true);

    await replayMigration();

    expect(await webRow(open)).toEqual({ enabled: true });
    expect(await webRow(keyed)).toEqual({ enabled: true });
    const auth = await queryClient<{ slug: string; auth_enabled: boolean }[]>`
      SELECT slug, auth_enabled FROM instances WHERE slug IN ('w91-open', 'w91-keyed')`;
    expect(Object.fromEntries(auth.map((r) => [r.slug, r.auth_enabled]))).toEqual({
      "w91-open": false,
      "w91-keyed": true,
    });
  });

  it("is safe to replay: an agent switched off since stays off", async () => {
    const id = await plantAgent("w91-open", true);
    await replayMigration();
    await queryClient`UPDATE instance_channels SET enabled = false WHERE instance_id = ${id} AND channel_type = 'web'`;
    await replayMigration();
    expect(await webRow(id)).toEqual({ enabled: false });
  });

  it("removes a demo-agent nobody used", async () => {
    await plantAgent("demo-agent", false);
    await replayMigration();
    expect(await exists("demo-agent")).toBe(false);
  });

  it("keeps a demo-agent that has a conversation, and gives it Web on like any existing agent", async () => {
    const id = await plantAgent("demo-agent", false);
    await queryClient`INSERT INTO conversations (conversation_id, instance_id)
      VALUES ('w91-conv', 'demo-agent')`;
    await replayMigration();
    expect(await exists("demo-agent")).toBe(true);
    expect(await webRow(id)).toEqual({ enabled: true });
  });

  it("keeps a demo-agent that was edited after the seed", async () => {
    const id = await plantAgent("demo-agent", false);
    await queryClient`UPDATE instances SET name = 'Mine', updated_at = now() + interval '1 minute' WHERE id = ${id}`;
    await replayMigration();
    expect(await exists("demo-agent")).toBe(true);
  });
});
