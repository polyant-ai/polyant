// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The catalog row that lets other agents call an agent as a tool, against a real
 * Postgres: written once per agent, updated in place, removed when switched off.
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { lockToolsTable, resolveDatabaseAvailability } from "../database/test-db.js";
import { syncAgentTool } from "./agent-tool-sync.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const SLUG = "itest-agent-tool-sync";
const NAME = `agent:${SLUG}`;

const rows = () =>
  queryClient<{ category: string; description: string }[]>`SELECT category, description FROM tools WHERE name = ${NAME}`;

describe.skipIf(!DB_AVAILABLE)("agent tool catalog row (integration)", () => {
  let release: () => Promise<void> = async () => {};

  beforeAll(async () => {
    release = await lockToolsTable("shared");
    await queryClient`DELETE FROM tools WHERE name = ${NAME}`;
  });

  afterAll(async () => {
    await queryClient`DELETE FROM tools WHERE name = ${NAME}`;
    await release();
  });

  it("writes one agent-category row, falling back to a generic description, and updates it in place", async () => {
    await syncAgentTool({ slug: SLUG, description: "  ", enable: true });
    expect(await rows()).toEqual([{ category: "agent", description: `Invoke the "${SLUG}" agent with a natural-language prompt.` }]);

    await syncAgentTool({ slug: SLUG, description: "Expert at enrichment", enable: true });
    expect(await rows()).toEqual([{ category: "agent", description: "Expert at enrichment" }]);
  });

  it("removes the row when the agent is no longer offered as a tool", async () => {
    await syncAgentTool({ slug: SLUG, description: null, enable: false });

    expect(await rows()).toEqual([]);
  });
});
