// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceUuid } from "./identifiers.js";

const rows: any[] = [];
vi.mock("../database/client.js", () => ({
  db: {
    insert: () => ({ values: (v: any) => ({ onConflictDoUpdate: ({ set }: any) => { const i = rows.findIndex((r) => r.instanceId === v.instanceId && r.slug === v.slug); if (i >= 0) rows[i] = { ...rows[i], ...set }; else rows.push(v); } }) }),
    select: () => ({ from: () => ({ where: () => rows.slice() }) }),
    delete: () => ({ where: () => { rows.length = 0; } }),
    update: () => ({ set: () => ({ where: () => {} }) }),
  },
}));

const { setMcpServer, listEnabledMcpServers, mcpServerConfigSchema } = await import("./mcp-servers.store.js");
const IID = asInstanceUuid("11111111-1111-1111-1111-111111111111");

describe("mcp-servers.store", () => {
  beforeEach(() => { rows.length = 0; });

  it("should_reject_static_config_without_auth", () => {
    expect(() => mcpServerConfigSchema("static", { allowList: [] })).toThrow();
  });

  it("should_accept_oauth_config_with_only_scopes", () => {
    expect(mcpServerConfigSchema("oauth", { scopes: ["repo"] })).toMatchObject({ scopes: ["repo"] });
  });

  it("should_encrypt_and_round_trip_a_static_server", async () => {
    await setMcpServer(IID, {
      slug: "github", name: "GitHub", url: "https://mcp.example.com", authMode: "static", enabled: true,
      config: { auth: { type: "bearer", token: "secret-token" } },
    });
    const enabled = await listEnabledMcpServers(IID);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].config).toMatchObject({ auth: { type: "bearer", token: "secret-token" } });
    // the persisted row's config column must NOT be plaintext
    expect(rows[0].config).not.toContain("secret-token");
  });

  it("should_strip_stray_token_key_from_oauth_config_before_persisting", async () => {
    await setMcpServer(IID, {
      slug: "oauth-server", name: "OAuth Server", url: "https://mcp.example.com", authMode: "oauth", enabled: true,
      config: { scopes: ["repo"], token: "leak" },
    });
    const enabled = await listEnabledMcpServers(IID);
    expect(enabled[0].config).toMatchObject({ scopes: ["repo"] });
    expect(enabled[0].config).not.toHaveProperty("token");
  });
});
