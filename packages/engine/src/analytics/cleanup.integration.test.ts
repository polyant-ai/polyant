// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for retention. There was none — the job that decides which
 * rows leave the database had no test of any kind.
 *
 * It has to be an integration test: the whole behaviour is SQL. A mock cannot
 * have the wrong predicate, cannot tell us whether the driver reports a row
 * count for a `delete` with no `returning`, and cannot catch the one semantic
 * trap here — that `event_backlog` has a lifecycle and only its COMPLETED rows
 * may age out.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { queryClient } from "../database/client.js";
import { computeCutoff, runAnalyticsCleanup } from "./cleanup.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-retention";

const OLD = "now() - interval '400 days'";
const NEW = "now() - interval '1 day'";

let instanceUuid: string;
let instanceSlug: string;
let definitionId: string;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM event_backlog WHERE instance_id IN (SELECT id FROM instances WHERE slug LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM event_definitions WHERE name LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM event_sources WHERE name LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM tool_audit_logs WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM hook_executions WHERE conversation_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("retention cleanup (integration)", () => {
  beforeAll(async () => {
    await teardown();
    const [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'r', false) RETURNING id`;
    const [{ id: wsId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default) VALUES (${orgId}, ${MARKER}, 'r', false) RETURNING id`;
    instanceSlug = `${MARKER}-agent`;
    const [{ id }] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id) VALUES (${instanceSlug}, 'r', ${wsId}) RETURNING id`;
    instanceUuid = id;

    const [{ id: srcId }] = await queryClient<{ id: string }[]>`
      INSERT INTO event_sources (instance_id, name, source_type, config, webhook_token)
      VALUES (${instanceUuid}, ${MARKER + "-src"}, 'webhook', '{}'::jsonb, ${MARKER + "-tok"}) RETURNING id`;
    const [{ id: defId }] = await queryClient<{ id: string }[]>`
      INSERT INTO event_definitions (event_source_id, name, matching_prompt, interpretation_prompt, action)
      VALUES (${srcId}, ${MARKER + "-def"}, 'x', '', 'backlog') RETURNING id`;
    definitionId = defId;
  });

  afterAll(teardown);

  beforeEach(async () => {
    await queryClient`DELETE FROM event_backlog WHERE instance_id = ${instanceUuid}`;
    await queryClient`DELETE FROM tool_audit_logs WHERE instance_id = ${instanceSlug}`;
    await queryClient`DELETE FROM hook_executions WHERE conversation_id LIKE ${MARKER + "%"}`;
  });

  it("should_delete_rows_past_the_cutoff_and_keep_the_rest", async () => {
    await queryClient.unsafe(
      `INSERT INTO tool_audit_logs (instance_id, tool_name, action, success, created_at)
       VALUES ('${instanceSlug}', 't', 'a', true, ${OLD}), ('${instanceSlug}', 't', 'a', true, ${NEW})`,
    );

    const result = await runAnalyticsCleanup(90);

    // The driver must report a count for a delete with no RETURNING — the whole
    // point of not materialising ids in a job built for large deletes.
    expect(result.toolAuditLogsDeleted).toBe(1);

    const [{ n }] = await queryClient<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tool_audit_logs WHERE instance_id = ${instanceSlug}`;
    expect(n).toBe(1);
  });

  /*
    event_backlog is the one table here with a lifecycle. `pending` is work still
    queued and `processing` may be a zombie that resetStuckProcessingEvents()
    recovers at boot — ageing either out by date would silently drop events the
    system still owes an answer for.
  */
  it("should_age_out_only_COMPLETED_backlog_events", async () => {
    for (const status of ["pending", "processing", "completed"]) {
      await queryClient.unsafe(
        `INSERT INTO event_backlog (instance_id, event_definition_id, raw_payload, status, created_at)
         VALUES ('${instanceUuid}', '${definitionId}', '{}'::jsonb, '${status}', ${OLD})`,
      );
    }

    const result = await runAnalyticsCleanup(90);

    expect(result.eventBacklogDeleted).toBe(1);
    const rows = await queryClient<{ status: string }[]>`
      SELECT status FROM event_backlog WHERE instance_id = ${instanceUuid} ORDER BY status`;
    expect(rows.map((r) => r.status)).toEqual(["pending", "processing"]);
  });

  it("should_report_zero_and_touch_nothing_when_everything_is_recent", async () => {
    await queryClient.unsafe(
      `INSERT INTO tool_audit_logs (instance_id, tool_name, action, success, created_at)
       VALUES ('${instanceSlug}', 't', 'a', true, ${NEW})`,
    );

    const result = await runAnalyticsCleanup(90);

    expect(result.toolAuditLogsDeleted).toBe(0);
    expect(result.cutoff.getTime()).toBeLessThan(Date.now());
  });

  it("should_compute_the_cutoff_from_the_retention_window", () => {
    const now = new Date("2026-08-28T00:00:00Z");
    expect(computeCutoff(90, now).toISOString()).toBe("2026-05-30T00:00:00.000Z");
  });
});
