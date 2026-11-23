// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An agent's MCP servers against a real Postgres: the config is stored
 * encrypted and validated, a second save of a slug replaces the first, the
 * enabled list is that agent's in slug order, and a delete reaches one server.
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queryClient } from "../database/client.js";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { asInstanceUuid, type InstanceUuid } from "./identifiers.js";
import { deleteMcpServer, listEnabledMcpServers, listMcpServers, setMcpServer } from "./mcp-servers.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-mcp-store";
let agent: InstanceUuid;
let other: InstanceUuid;

async function plant(slug: string): Promise<InstanceUuid> {
  const [row] = await queryClient<{ id: string }[]>`
    INSERT INTO instances (slug, name, workspace_id)
    VALUES (${slug}, ${slug}, (SELECT id FROM workspaces WHERE is_default = true LIMIT 1)) RETURNING id`;
  return asInstanceUuid(row!.id);
}

const server = (slug: string, extra: Partial<Parameters<typeof setMcpServer>[1]> = {}) => ({
  slug, name: slug, url: "https://mcp.example.com", authMode: "none" as const, enabled: true, config: {}, ...extra,
});

describe.skipIf(!DB_AVAILABLE)("MCP server store (integration)", () => {
  beforeAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
    agent = await plant(`${MARKER}-agent`);
    other = await plant(`${MARKER}-other`);
  });

  beforeEach(async () => {
    await queryClient`DELETE FROM instance_mcp_servers WHERE instance_id IN (${agent}, ${other})`;
  });

  afterAll(async () => {
    await queryClient`DELETE FROM instances WHERE slug LIKE ${MARKER + "%"}`;
  });

  it("lists the agent's enabled servers in slug order, whatever order they were saved and updated in", async () => {
    for (const slug of ["widget", "arcadia", "kb", "zeta-off"]) {
      await setMcpServer(agent, server(slug, { enabled: slug !== "zeta-off" }));
    }
    await setMcpServer(agent, server("arcadia", { name: "Arcadia renamed" }));
    await setMcpServer(other, server("aaa-theirs"));

    const enabled = await listEnabledMcpServers(agent);

    expect(enabled.map((s) => s.slug)).toEqual(["arcadia", "kb", "widget"]);
    expect(enabled[0]!.name).toBe("Arcadia renamed");
    expect((await listMcpServers(agent)).map((s) => s.slug).sort()).toEqual(["arcadia", "kb", "widget", "zeta-off"]);
  });

  it("stores a static server's token encrypted and reads it back", async () => {
    await setMcpServer(agent, server("github", { authMode: "static", config: { auth: { type: "bearer", token: "secret-token" } } }));

    const [row] = await queryClient<{ config: string }[]>`
      SELECT config FROM instance_mcp_servers WHERE instance_id = ${agent} AND slug = 'github'`;
    expect(row!.config).not.toContain("secret-token");
    expect((await listEnabledMcpServers(agent))[0]!.config).toMatchObject({ auth: { type: "bearer", token: "secret-token" } });
  });

  it("drops a stray token from an oauth config before storing it", async () => {
    await setMcpServer(agent, server("oauth-server", { authMode: "oauth", config: { scopes: ["repo"], token: "leak" } }));

    const [stored] = await listEnabledMcpServers(agent);
    expect(stored!.config).toMatchObject({ scopes: ["repo"] });
    expect(stored!.config).not.toHaveProperty("token");
  });

  it("deletes one server of one agent", async () => {
    await setMcpServer(agent, server("keep"));
    await setMcpServer(agent, server("gone"));
    await setMcpServer(other, server("gone"));

    await deleteMcpServer(agent, "gone");

    expect((await listMcpServers(agent)).map((s) => s.slug)).toEqual(["keep"]);
    expect((await listMcpServers(other)).map((s) => s.slug)).toEqual(["gone"]);
  });
});
