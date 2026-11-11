// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web channel's gate, against a real database: whether a web turn may run,
 * and what it costs to decide. Every web turn passes here before the pipeline,
 * so a warm agent should be decided from the caches without a round trip, and
 * a change to the switch or the key must still count at once on this process.
 * Self-skips without a database; CI_REQUIRE_DB makes an absent one a failure.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const selects = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../database/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../database/client.js")>();
  const select = actual.db.select.bind(actual.db);
  const db = new Proxy(actual.db, {
    get(target, prop, receiver) {
      if (prop === "select") {
        return (...args: Parameters<typeof select>) => {
          selects.count++;
          return select(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, db, NO_TRANSACTION: db };
});

import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { queryClient } from "../../database/client.js";
import { resolveDatabaseAvailability } from "../../database/test-db.js";
import { asInstanceSlug, asInstanceUuid, type InstanceUuid } from "../../instances/identifiers.js";
import { WEB_CHANNEL_TYPE, deleteChannelConfig, setChannelConfig } from "../../instances/channels.store.js";
import { SECRET_KEYS, setSecret } from "../../instances/secrets.store.js";
import { invalidateInstanceConfigCache } from "../../instances/config-resolver.js";
import { validateInstanceApiKey } from "./instance-api-key-auth.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = "itest-web-gate";
const turn = { carriesContext: false };
let agentId: InstanceUuid;

describe.skipIf(!DB_AVAILABLE)("web channel gate (integration)", () => {
  beforeAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug = ${SLUG}`;
    const [row] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, auth_enabled, workspace_id)
      VALUES (${SLUG}, ${SLUG}, true, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1))
      RETURNING id`;
    agentId = asInstanceUuid(row.id);
    await setSecret(agentId, SECRET_KEYS.AUTH_API_KEY, "web-key");
  });

  beforeEach(async () => {
    await setChannelConfig(agentId, WEB_CHANNEL_TYPE, {}, true);
    invalidateInstanceConfigCache(asInstanceSlug(SLUG));
  });

  afterAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug = ${SLUG}`;
  });

  it("decides a warm agent's web turn without reading the database", async () => {
    await validateInstanceApiKey(SLUG, "Bearer web-key", turn);
    selects.count = 0;
    await validateInstanceApiKey(SLUG, "Bearer web-key", turn);
    expect(selects.count).toBe(0);
  });

  it("refuses a wrong key on a warm agent", async () => {
    await validateInstanceApiKey(SLUG, "Bearer web-key", turn);
    await expect(validateInstanceApiKey(SLUG, "Bearer nope", turn)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("answers 404 as soon as the web channel is switched off or removed", async () => {
    await validateInstanceApiKey(SLUG, "Bearer web-key", turn);
    await setChannelConfig(agentId, WEB_CHANNEL_TYPE, {}, false);
    await expect(validateInstanceApiKey(SLUG, "Bearer web-key", turn)).rejects.toBeInstanceOf(NotFoundException);

    await setChannelConfig(agentId, WEB_CHANNEL_TYPE, {}, true);
    await validateInstanceApiKey(SLUG, "Bearer web-key", turn);
    await deleteChannelConfig(agentId, WEB_CHANNEL_TYPE);
    await expect(validateInstanceApiKey(SLUG, "Bearer web-key", turn)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("answers 404 for an agent that does not exist", async () => {
    await expect(validateInstanceApiKey("itest-web-gate-missing", "Bearer web-key", turn))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
