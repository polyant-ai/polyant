// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration test for the round trip the coverage guardrail cannot see: a field
 * the bundle schema carries still has to be WRITTEN by both import paths, and
 * each of them lists its columns by hand.
 *
 * Self-skips without a database; CI_REQUIRE_DB makes an absent database a failure there.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { queryClient } from "../database/client.js";
import { createInstanceWithDefaults } from "./store.js";
import { asInstanceSlug, asInstanceUuid } from "./identifiers.js";
import { setSecret, getAllSecretsById } from "./secrets.store.js";
import { exportInstance } from "./export.service.js";
import { importNewInstance, importOverwriteInstance } from "./import.service.js";
import { _registerToolForTests, _resetRegistryForTests } from "../agents/tools/registry.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-export-import";

let orgId: string;

async function teardown(): Promise<void> {
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
});
