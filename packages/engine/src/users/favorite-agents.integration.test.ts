// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A person's starred agents against a real database: a star lands on the
 * caller's rows only, a second star is a no-op, the limit holds, an agent id
 * that names no agent is refused by the foreign key, and deleting the agent
 * takes its stars with it.
 *
 * Self-skips without a migrated database.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { insertUser } from "./users.store.js";
import {
  addFavoriteAgent,
  FAVORITE_AGENTS_LIMIT,
  listFavoriteAgentIds,
  removeFavoriteAgent,
} from "./favorite-agents.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-favorite-agents";

describe.skipIf(!DB_AVAILABLE)("user favorite agents", () => {
  const emails = [`${MARKER}-a@example.test`, `${MARKER}-b@example.test`];
  const cleanup = async () => {
    // Stars go with the user and the agent (both cascade).
    await queryClient`DELETE FROM users WHERE email IN ${queryClient(emails)}`;
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  };
  beforeEach(cleanup);
  afterEach(cleanup);

  async function plantUser(email: string): Promise<string> {
    const u = await insertUser({ email, passwordHash: null, isPlatformAdmin: false, mustChangePassword: false });
    return u.id;
  }

  async function plantAgents(count: number): Promise<string[]> {
    const rows = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id)
      SELECT ${MARKER + "-"} || n, 'favorite ' || n, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1)
      FROM generate_series(1, ${count}::int) AS n
      RETURNING id`;
    return rows.map((r) => r.id);
  }

  it("adds, lists oldest first, and removes", async () => {
    const a = await plantUser(emails[0]);
    const [first, second] = await plantAgents(2);

    expect(await addFavoriteAgent(a, second)).toBe("added");
    expect(await addFavoriteAgent(a, first)).toBe("added");
    expect(await listFavoriteAgentIds(a)).toEqual([second, first]);

    await removeFavoriteAgent(a, second);
    expect(await listFavoriteAgentIds(a)).toEqual([first]);
    // Removing what is not there is not an error.
    await removeFavoriteAgent(a, second);
    expect(await listFavoriteAgentIds(a)).toEqual([first]);
  });

  it("treats a second star on the same agent as already there", async () => {
    const a = await plantUser(emails[0]);
    const [agent] = await plantAgents(1);
    expect(await addFavoriteAgent(a, agent)).toBe("added");
    expect(await addFavoriteAgent(a, agent)).toBe("already");
    expect(await listFavoriteAgentIds(a)).toEqual([agent]);
  });

  it("refuses a star past the limit and still accepts one already held", async () => {
    const a = await plantUser(emails[0]);
    const agents = await plantAgents(FAVORITE_AGENTS_LIMIT + 1);
    for (const id of agents.slice(0, FAVORITE_AGENTS_LIMIT)) {
      expect(await addFavoriteAgent(a, id)).toBe("added");
    }
    expect(await addFavoriteAgent(a, agents[FAVORITE_AGENTS_LIMIT])).toBe("limit");
    expect(await addFavoriteAgent(a, agents[0])).toBe("already");
    expect(await listFavoriteAgentIds(a)).toHaveLength(FAVORITE_AGENTS_LIMIT);
  });

  it("answers unknown-agent for an id that names no agent", async () => {
    const a = await plantUser(emails[0]);
    expect(await addFavoriteAgent(a, randomUUID())).toBe("unknown-agent");
    expect(await listFavoriteAgentIds(a)).toEqual([]);
  });

  it("drops the star when the agent is deleted", async () => {
    const a = await plantUser(emails[0]);
    const [agent, kept] = await plantAgents(2);
    await addFavoriteAgent(a, agent);
    await addFavoriteAgent(a, kept);

    await queryClient`DELETE FROM instances WHERE id = ${agent}`;

    expect(await listFavoriteAgentIds(a)).toEqual([kept]);
  });

  it("leaves another user's stars untouched", async () => {
    const a = await plantUser(emails[0]);
    const b = await plantUser(emails[1]);
    const [agent] = await plantAgents(1);
    await addFavoriteAgent(a, agent);
    await addFavoriteAgent(b, agent);

    await removeFavoriteAgent(a, agent);

    expect(await listFavoriteAgentIds(a)).toEqual([]);
    expect(await listFavoriteAgentIds(b)).toEqual([agent]);
  });
});
