// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A Room cycle against a real Postgres: the events it claims from the backlog,
 * the handling instructions and source types it reads for their definitions,
 * and what the model is handed as a result. Only the model call (`supervise`)
 * and memory extraction are replaced. Self-skips when no migrated database is
 * reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSupervise } = vi.hoisted(() => ({ mockSupervise: vi.fn() }));
vi.mock("../agents/supervisor/index.js", () => ({ supervise: mockSupervise }));
vi.mock("../memory/extractor.js", () => ({ extractMemories: vi.fn(async () => undefined) }));

import { lockRoomEventBacklog, resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceSlug, asInstanceUuid } from "../instances/identifiers.js";
import { insertEvent } from "../webhooks/webhook-backlog.store.js";
import { executeRoomCycle } from "./room-engine.js";
import type { RoomConfig } from "./room.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-room-engine";
const SLUG = asInstanceSlug(`${MARKER}-agent`);
const OWNER = `${MARKER}-owner`;

let room: RoomConfig;
const definitionOf: Record<string, string> = {};
let releaseBacklog: () => Promise<void>;

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM conversations WHERE instance_id = ${SLUG}`;
  await queryClient`DELETE FROM event_backlog WHERE instance_id IN (SELECT id FROM instances WHERE slug LIKE ${MARKER + "%"})`;
  await queryClient`DELETE FROM event_definitions WHERE name LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM event_sources WHERE name LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
}

async function addDefinition(instanceId: string, key: string, sourceType: string, prompt: string): Promise<void> {
  const [{ id: srcId }] = await queryClient<{ id: string }[]>`
    INSERT INTO event_sources (instance_id, name, source_type, config, webhook_token)
    VALUES (${instanceId}, ${`${MARKER}-${key}-src`}, ${sourceType}, '{}'::jsonb, ${`${MARKER}-${key}-tok`}) RETURNING id`;
  const [{ id }] = await queryClient<{ id: string }[]>`
    INSERT INTO event_definitions (event_source_id, name, matching_prompt, interpretation_prompt, action)
    VALUES (${srcId}, ${`${MARKER}-${key}`}, 'x', ${prompt}, 'backlog') RETURNING id`;
  definitionOf[key] = id;
}

/** The message the model was handed in the last cycle. */
const handed = () => mockSupervise.mock.calls.at(-1)![0].message as string;

describe.skipIf(!DB_AVAILABLE)("room cycle (integration)", () => {
  beforeAll(async () => {
    releaseBacklog = await lockRoomEventBacklog("shared");
    await teardown();
    const [{ id }] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${SLUG}, 'room', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1)) RETURNING id`;
    const [{ id: otherId }] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id)
      VALUES (${`${MARKER}-other`}, 'other', (SELECT id FROM workspaces WHERE is_default = true LIMIT 1)) RETURNING id`;
    room = {
      id: "room-1",
      instanceId: asInstanceUuid(id),
      enabled: true,
      prompt: "You run the room.",
      outboundChannel: null,
      outboundTarget: null,
      conversationId: null,
    };
    await addDefinition(id, "issues", "github", "Triage the issue.");
    await addDefinition(id, "deals", "hubspot", "Follow up the deal.");
    await addDefinition(id, "idle", "webhook", "A definition with no pending event.");
    await addDefinition(otherId, "foreign", "webhook", "Another agent's instructions.");
  });

  beforeEach(async () => {
    mockSupervise.mockReset().mockResolvedValue({
      text: "Handled.",
      steps: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      durationMs: 1,
      toolBuildingMs: 0,
    });
    await queryClient`DELETE FROM event_backlog WHERE instance_id = ${room.instanceId}`;
  });

  afterAll(async () => {
    await teardown();
    await releaseBacklog();
  });

  it("hands the model each claimed event with the instructions of its own definitions only", async () => {
    await insertEvent(room.instanceId, definitionOf.issues!, { orderId: 123 });
    await insertEvent(room.instanceId, definitionOf.deals!, { orderId: 456 });

    await executeRoomCycle(room, SLUG, OWNER);

    const message = handed();
    expect(message).toContain("## Pending Events (2)");
    expect(message).toContain('"orderId":123');
    expect(message).toContain('"orderId":456');
    expect(message).toContain("## Event Handling Instructions");
    expect(message).toContain(`### ${MARKER}-issues`);
    expect(message).toContain("Triage the issue.");
    expect(message).toContain("Follow up the deal.");
    expect(message).not.toContain("A definition with no pending event.");
    expect(message).not.toContain("Another agent's instructions.");
  });

  it("renders a payload by its definition's source type: GitHub without its API URL templates, others unchanged", async () => {
    await insertEvent(room.instanceId, definitionOf.issues!, {
      action: "opened",
      issue: { number: 7, title: "Broken link", html_url: "https://github.com/acme/app/issues/7" },
      sender: { login: "octocat", node_id: "MDQ6", followers_url: "https://api.github.com/users/octocat/followers" },
    });
    await insertEvent(room.instanceId, definitionOf.deals!, { objectId: 42, portal_url: "https://app.hubspot.com/x" });

    await executeRoomCycle(room, SLUG, OWNER);

    const message = handed();
    expect(message).toContain('"login":"octocat"');
    expect(message).toContain("https://github.com/acme/app/issues/7");
    expect(message).not.toContain("followers_url");
    expect(message).not.toContain("node_id");
    expect(message).toContain("portal_url");
  });

  it("completes the events it claimed, so the next cycle has nothing to do", async () => {
    await insertEvent(room.instanceId, definitionOf.issues!, { n: 1 });

    await executeRoomCycle(room, SLUG, OWNER);
    await executeRoomCycle(room, SLUG, OWNER);

    expect(mockSupervise).toHaveBeenCalledTimes(1);
    const rows = await queryClient<{ status: string }[]>`
      SELECT status FROM event_backlog WHERE instance_id = ${room.instanceId}`;
    expect(rows.map((r) => r.status)).toEqual(["completed"]);
  });
});
