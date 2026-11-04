// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Webhook delivery keys against a real database: the first delivery of a key
 * is claimed, a redelivery is not, on any process. Self-skips without a
 * database; CI_REQUIRE_DB makes an absent one a failure there.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceUuid, type InstanceUuid } from "../instances/identifiers.js";
import { createEventSource } from "./webhook-sources.store.js";
import { claimWebhookDelivery } from "./webhook-deliveries.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-webhook-deliveries";

describe.skipIf(!DB_AVAILABLE)("claimWebhookDelivery (integration)", () => {
  let sourceA: string;
  let sourceB: string;

  beforeAll(async () => {
    const [row] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${MARKER}, ${MARKER}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
      RETURNING id`;
    const agent: InstanceUuid = asInstanceUuid(row.id);
    sourceA = (await createEventSource(agent, { name: "a", sourceType: "generic", config: {} })).id;
    sourceB = (await createEventSource(agent, { name: "b", sourceType: "generic", config: {} })).id;
  });

  afterAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug = ${MARKER}`;
  });

  it("claims a key once", async () => {
    expect(await claimWebhookDelivery(sourceA, "evt-1")).toBe(true);
    expect(await claimWebhookDelivery(sourceA, "evt-1")).toBe(false);
  });

  it("claims one key once even when the copies arrive together", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => claimWebhookDelivery(sourceA, "evt-burst")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("keeps the keys of two sources apart", async () => {
    expect(await claimWebhookDelivery(sourceA, "evt-shared")).toBe(true);
    expect(await claimWebhookDelivery(sourceB, "evt-shared")).toBe(true);
  });

  it("claims a key again once its record has expired", async () => {
    expect(await claimWebhookDelivery(sourceA, "evt-old")).toBe(true);
    await queryClient`
      UPDATE webhook_deliveries SET received_at = now() - interval '2 days'
      WHERE event_source_id = ${sourceA}`;

    expect(await claimWebhookDelivery(sourceA, "evt-old")).toBe(true);
  });
});
