// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The agent's shared MCP account against a real migrated Postgres (migration
 * 0094). The break this catches: tokens issued for one server address
 * surviving an edit that points the server elsewhere, or that stops it using
 * the shared account.
 *
 * Self-skips when no migrated database is reachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { queryClient } from "../database/client.js";
import { asInstanceUuid } from "./identifiers.js";
import {
  clearMcpSharedTokens,
  getMcpServer,
  getMcpSharedTokens,
  saveMcpSharedTokens,
  setMcpServer,
} from "./mcp-servers.store.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();

const MARKER = `itest-mcp-shared-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const URL_A = "https://mcp.linear.test/mcp";
const ADMIN = "33333333-3333-3333-3333-333333333333";

async function teardown(): Promise<void> {
  await queryClient`DELETE FROM instance_mcp_servers WHERE instance_id IN (
    SELECT id FROM instances WHERE slug LIKE ${MARKER + "%"}
  )`;
  await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM workspaces WHERE slug LIKE ${MARKER + "%"}`;
  await queryClient`DELETE FROM organizations WHERE slug LIKE ${MARKER + "%"}`;
}

describe.skipIf(!DB_AVAILABLE)("the shared MCP account against a real migrated table", () => {
  let orgId: string;
  let agent: ReturnType<typeof asInstanceUuid>;

  const saveShared = (url = URL_A, account = "shared") =>
    setMcpServer(agent, { slug: "linear", name: "Linear", url, authMode: "oauth", enabled: true, config: { account } });

  beforeAll(async () => {
    await teardown();
    [{ id: orgId }] = await queryClient<{ id: string }[]>`
      INSERT INTO organizations (slug, name, is_default) VALUES (${MARKER}, 'MCP shared org', false) RETURNING id`;
    const [{ id: workspaceId }] = await queryClient<{ id: string }[]>`
      INSERT INTO workspaces (organization_id, slug, name, is_default)
      VALUES (${orgId}, ${MARKER}, 'MCP shared workspace', false) RETURNING id`;
    const [{ id }] = await queryClient<{ id: string }[]>`
      INSERT INTO instances (slug, name, workspace_id) VALUES (${`${MARKER}-agent`}, 'MCP shared agent', ${workspaceId}) RETURNING id`;
    agent = asInstanceUuid(id);
  });

  beforeEach(async () => {
    await saveShared();
    await saveMcpSharedTokens(agent, "linear", '{"access_token":"at-1"}', { by: ADMIN });
  });

  afterAll(teardown);

  it("reports who connected it while keeping the tokens out of the record", async () => {
    const server = await getMcpServer(agent, "linear");
    expect(server?.sharedAccount).toMatchObject({ connectedBy: ADMIN });
    expect(JSON.stringify(server)).not.toContain("at-1");
    expect(await getMcpSharedTokens(agent, "linear")).toBe('{"access_token":"at-1"}');
  });

  it("keeps the account when the server is edited at the same address", async () => {
    await saveShared();
    expect(await getMcpSharedTokens(agent, "linear")).not.toBeNull();
  });

  it("keeps who connected it across a refresh", async () => {
    await saveMcpSharedTokens(agent, "linear", '{"access_token":"at-2"}');
    expect((await getMcpServer(agent, "linear"))?.sharedAccount).toMatchObject({ connectedBy: ADMIN });
    expect(await getMcpSharedTokens(agent, "linear")).toBe('{"access_token":"at-2"}');
  });

  it("drops the account when the server moves to another address", async () => {
    await saveShared("https://elsewhere.test/mcp");
    expect(await getMcpSharedTokens(agent, "linear")).toBeNull();
    expect((await getMcpServer(agent, "linear"))?.sharedAccount).toBeNull();
  });

  it("drops the account when the server goes back to per-conversation authorization", async () => {
    await saveShared(URL_A, "conversation");
    expect(await getMcpSharedTokens(agent, "linear")).toBeNull();
  });

  it("keeps tokens a concurrent refresh saved after the refused one read them", async () => {
    await saveMcpSharedTokens(agent, "linear", '{"access_token":"at-2","refresh_token":"rt-2"}');
    expect(await clearMcpSharedTokens(agent, "linear", { access_token: "at-1" })).toBe(false);
    expect(await getMcpSharedTokens(agent, "linear")).toBe('{"access_token":"at-2","refresh_token":"rt-2"}');
    expect(await clearMcpSharedTokens(agent, "linear", { access_token: "at-2", refresh_token: "rt-2" })).toBe(true);
    expect(await getMcpSharedTokens(agent, "linear")).toBeNull();
  });

  it("says whether a disconnect removed anything", async () => {
    expect(await clearMcpSharedTokens(agent, "linear")).toBe(true);
    expect(await clearMcpSharedTokens(agent, "linear")).toBe(false);
  });
});
