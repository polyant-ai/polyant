// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for the round trip the coverage guardrail cannot see: a field
 * the bundle schema carries still has to be WRITTEN by both import paths, and
 * each of them lists its columns by hand.
 *
 * Self-skips without a database; CI_REQUIRE_DB makes an absent database a failure there.
 */

import { lockToolsTable, resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { queryClient } from "../database/client.js";
import { createInstanceWithDefaults, findInstanceBySlug, findInstanceIcon } from "./store.js";
import { asInstanceSlug, asInstanceUuid } from "./identifiers.js";
import { setSecret, getAllSecretsById } from "./secrets.store.js";
import { exportInstance } from "./export.service.js";
import { importNewInstance, importOverwriteInstance } from "./import.service.js";
import { _registerToolForTests, _resetRegistryForTests } from "../agents/tools/registry.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-export-import";

let orgId: string;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM scheduled_tasks WHERE instance_id LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

async function createAgent(suffix: string) {
  return createInstanceWithDefaults({
    slug: asInstanceSlug(`${MARKER}-${suffix}`),
    name: `Round trip ${suffix}`,
    orgId,
    workspaceSlug: MARKER + "-ws",
  });
}

describe.skipIf(!DB_AVAILABLE)("export → import round trip (integration)", () => {
  // Agents are created with their default tools: keep a prune of the catalog
  // (`database/test-db.ts`) from running while they are.
  let releaseToolsLock: () => Promise<void> = async () => {};
  beforeAll(async () => {
    releaseToolsLock = await lockToolsTable("shared");
  });
  afterAll(async () => {
    await releaseToolsLock();
  });

  beforeAll(async () => {
    await teardown();
    const [org] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'round trip org', false)
      RETURNING id`;
    orgId = org.id;
    await queryClient`
      INSERT INTO workspaces (organization_id, slug, name, is_default)
      VALUES (${orgId}, ${MARKER + "-ws"}, 'round trip ws', false)`;

    _resetRegistryForTests();
    _registerToolForTests(
      defineTool({
        name: "itestCrmLookup",
        description: "declares one parameter and one credential",
        parameters: z.object({}),
        requiredSecrets: [
          { key: "itest_crm_base_url", type: "text", sensitive: false },
          "itest_crm_api_key",
        ],
        execute: async () => ({}),
      }),
    );
  });

  afterAll(async () => {
    _resetRegistryForTests();
    await teardown();
  });

  it("should_restore_the_thinking_level_and_the_readable_parameters_and_ask_for_the_credential", async () => {
    const source = await createAgent("source");
    await queryClient`UPDATE instances SET thinking_level = 'high' WHERE id = ${source.id}`;
    await setSecret(source.id, "itest_crm_base_url", "https://crm.example.test");
    await setSecret(source.id, "itest_crm_api_key", "source-credential");

    const bundle = await exportInstance(source.slug);
    expect(bundle.instance.thinkingLevel).toBe("high");
    expect(JSON.stringify(bundle)).not.toContain("source-credential");

    const result = await importNewInstance(bundle, orgId);

    const [row] = await queryClient<{ id: string; thinking_level: string }[]>`
      SELECT id, thinking_level FROM instances WHERE slug = ${result.slug}`;
    expect(row.thinking_level).toBe("high");
    expect(await getAllSecretsById(asInstanceUuid(row.id))).toEqual({ itest_crm_base_url: "https://crm.example.test" });
    expect(result.warnings).toContainEqual({
      type: "secret_required",
      message: 'Secret "itest_crm_api_key" needs to be configured',
    });
  });

  it("should_export_an_unknown_stored_transcription_provider_as_off_and_import_it", async () => {
    // A value written before the setting was validated: the runtime reads it as off.
    const source = await createAgent("stt-typo");
    await queryClient`UPDATE instances SET stt_provider = 'openia' WHERE id = ${source.id}`;

    const bundle = await exportInstance(source.slug);
    expect(bundle.instance.sttProvider).toBe("disabled");

    const result = await importNewInstance(bundle, orgId);
    const [row] = await queryClient<{ stt_provider: string }[]>`
      SELECT stt_provider FROM instances WHERE slug = ${result.slug}`;
    expect(row.stt_provider).toBe("disabled");
  });

  it("should_carry_a_scheduled_task_with_an_interval_shorter_than_new_schedules_may_declare", async () => {
    // A task an earlier release accepted: its API took any interval.
    const source = await createAgent("short-interval");
    await queryClient`
      INSERT INTO scheduled_tasks (instance_id, name, schedule, prompt)
      VALUES (${source.slug}, 'poll', ${JSON.stringify({ type: "interval", everyMs: 30_000 })}::jsonb, 'Check the queue')`;

    const result = await importNewInstance(await exportInstance(source.slug), orgId);

    const rows = await queryClient<{ schedule: unknown; next_run_at: Date | null }[]>`
      SELECT schedule, next_run_at FROM scheduled_tasks WHERE instance_id = ${result.slug}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toEqual({ type: "interval", everyMs: 30_000 });
    expect(rows[0].next_run_at).not.toBeNull();
  });

  it("should_read_the_agent_without_its_icon_and_still_carry_the_icon_through_a_round_trip", async () => {
    const icon = `data:image/png;base64,${"QUJD".repeat(1000)}`;
    const source = await createAgent("icon");
    await queryClient`UPDATE instances SET icon = ${icon} WHERE id = ${source.id}`;

    const read = await findInstanceBySlug(source.slug);
    expect(read).toMatchObject({ hasIcon: true });
    expect(read).not.toHaveProperty("icon");

    const bundle = await exportInstance(source.slug);
    expect(bundle.instance.icon).toBe(icon);
    const result = await importNewInstance(bundle, orgId);
    expect(await findInstanceIcon(asInstanceSlug(result.slug))).toBe(icon);
  });

  it("should_carry_the_web_channel_state_through_a_round_trip", async () => {
    const webOf = async (slug: string) =>
      (await queryClient<{ enabled: boolean }[]>`
        SELECT c.enabled FROM instance_channels c JOIN instances i ON i.id = c.instance_id
        WHERE i.slug = ${slug} AND c.channel_type = 'web'`)[0]?.enabled;

    // A new agent has no web row, which means off; the bundle says so explicitly.
    const off = await createAgent("web-off");
    expect(await webOf(off.slug)).toBeUndefined();
    const offBundle = await exportInstance(off.slug);
    expect(offBundle.instance.channels).toContainEqual({ channelType: "web", enabled: false, config: {} });
    expect(await webOf((await importNewInstance(offBundle, orgId)).slug)).toBe(false);

    // Switched on, it stays on.
    const on = await createAgent("web-on");
    await queryClient`INSERT INTO instance_channels (instance_id, channel_type, enabled, config)
      VALUES (${on.id}, 'web', true, '')`;
    const onBundle = await exportInstance(on.slug);
    expect(await webOf((await importNewInstance(onBundle, orgId)).slug)).toBe(true);

    // A bundle from before Web was a channel has no row: its endpoint was online.
    const legacy = { ...offBundle, version: "1.2" as const, instance: { ...offBundle.instance, channels: [] } };
    expect(await webOf((await importNewInstance(legacy, orgId)).slug)).toBe(true);
  });

  it("should_replace_a_parameter_on_overwrite_and_leave_the_target_credential_alone", async () => {
    const source = await createAgent("ow-source");
    await queryClient`UPDATE instances SET thinking_level = 'max' WHERE id = ${source.id}`;
    await setSecret(source.id, "itest_crm_base_url", "https://new.example.test");

    const target = await createAgent("ow-target");
    await setSecret(target.id, "itest_crm_base_url", "https://old.example.test");
    await setSecret(target.id, "itest_crm_api_key", "target-credential");

    await importOverwriteInstance(target.slug, await exportInstance(source.slug));

    const [row] = await queryClient<{ thinking_level: string }[]>`
      SELECT thinking_level FROM instances WHERE id = ${target.id}`;
    expect(row.thinking_level).toBe("max");
    expect(await getAllSecretsById(target.id)).toEqual({
      itest_crm_base_url: "https://new.example.test",
      itest_crm_api_key: "target-credential",
    });
  });

  it("should_carry_the_attachment_storage_choice_and_keep_the_target_s_own_when_an_older_bundle_has_none", async () => {
    const source = await createAgent("att-source");
    const target = await createAgent("att-target");
    await queryClient`UPDATE instances SET attachment_storage_enabled = true WHERE id IN (${source.id}, ${target.id})`;

    const bundle = await exportInstance(source.slug);
    expect(bundle.instance.attachmentStorageEnabled).toBe(true);
    // A bundle from before the switch existed.
    const legacy = structuredClone(bundle);
    delete (legacy.instance as { attachmentStorageEnabled?: boolean }).attachmentStorageEnabled;

    const stored = async (slug: string) =>
      (await queryClient<{ on: boolean }[]>`SELECT attachment_storage_enabled AS on FROM instances WHERE slug = ${slug}`)[0]?.on;

    await importOverwriteInstance(target.slug, legacy);
    expect(await stored(target.slug)).toBe(true);

    expect(await stored((await importNewInstance(legacy, orgId)).slug)).toBe(false);
    expect(await stored((await importNewInstance(bundle, orgId)).slug)).toBe(true);
  });

  it("should_normalise_the_context_field_mapping_and_refuse_one_the_panel_would_refuse", async () => {
    const source = await createAgent("map-source");
    const target = await createAgent("map-target");
    await queryClient`UPDATE instances SET web_context_field_mapping = '{"phone":"caller.phone"}'::jsonb WHERE id = ${target.id}`;
    const bundle = await exportInstance(source.slug);
    const mapping = async (slug: string) =>
      (await queryClient<{ m: Record<string, string> }[]>`SELECT web_context_field_mapping AS m FROM instances WHERE slug = ${slug}`)[0]?.m;

    // Whitespace and an editor's blank row, as the PATCH normalises them.
    const messy = structuredClone(bundle);
    messy.instance.webContextFieldMapping = { "  phone ": " customer.phone ", "": "ignored" };
    expect(await mapping((await importNewInstance(messy, orgId)).slug)).toEqual({ phone: "customer.phone" });

    // An empty path segment: the PATCH answers 400, so the import fails and writes nothing.
    const invalid = structuredClone(bundle);
    invalid.instance.webContextFieldMapping = { phone: "customer..phone" };
    await expect(importOverwriteInstance(target.slug, invalid)).rejects.toThrow(/webContextFieldMapping/);
    expect(await mapping(target.slug)).toEqual({ phone: "caller.phone" });
    await expect(importNewInstance(invalid, orgId)).rejects.toThrow(/webContextFieldMapping/);
  });
});
