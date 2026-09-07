// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { asInstanceUuid } from "./identifiers.js";

// exportMcpServers only calls listMcpServers — mock the store, not the DB.
vi.mock("./mcp-servers.store.js", () => ({
  listMcpServers: vi.fn(),
}));

const mcpServersStoreModule = await import("./mcp-servers.store.js");
const listMcpServers = mcpServersStoreModule.listMcpServers as unknown as ReturnType<typeof vi.fn>;
const { exportMcpServers, stripMcpSecrets } = await import("./export.service.js");

const IID = asInstanceUuid("11111111-1111-1111-1111-111111111111");

describe("stripMcpSecrets", () => {
  it("should_remove_the_bearer_token_from_a_static_config", () => {
    const stripped = stripMcpSecrets("static", {
      auth: { type: "bearer", token: "super-secret-token" },
    });
    expect(stripped.auth).toMatchObject({ type: "bearer" });
    expect((stripped.auth as Record<string, unknown>)).not.toHaveProperty("token");
  });

  it("should_remove_the_header_token_from_a_static_header_config", () => {
    const stripped = stripMcpSecrets("static", {
      auth: { type: "header", headerName: "X-Api-Key", token: "super-secret-token" },
    });
    expect(stripped.auth).toMatchObject({ type: "header", headerName: "X-Api-Key" });
    expect((stripped.auth as Record<string, unknown>)).not.toHaveProperty("token");
  });

  it("should_remove_the_staticClient_clientSecret_from_an_oauth_config", () => {
    const stripped = stripMcpSecrets("oauth", {
      scopes: ["repo"],
      staticClient: { clientId: "abc123", clientSecret: "super-secret-client-secret" },
    });
    expect(stripped.staticClient).toMatchObject({ clientId: "abc123" });
    expect((stripped.staticClient as Record<string, unknown>)).not.toHaveProperty("clientSecret");
  });

  it("should_drop_dcrClient_entirely_from_an_oauth_config", () => {
    const stripped = stripMcpSecrets("oauth", {
      scopes: ["repo"],
      dcrClient: { client_id: "abc", client_secret: "shh", registration_access_token: "leak-me" },
    });
    expect(stripped).not.toHaveProperty("dcrClient");
  });

  it("should_keep_authServerInfo_urls_untouched", () => {
    const stripped = stripMcpSecrets("oauth", {
      authServerInfo: { authorizationServerUrl: "https://auth.example.com", tokenEndpoint: "https://auth.example.com/token" },
    });
    expect(stripped.authServerInfo).toEqual({
      authorizationServerUrl: "https://auth.example.com",
      tokenEndpoint: "https://auth.example.com/token",
    });
  });
});

describe("exportMcpServers", () => {
  it("SECURITY: a static server export never carries the bearer token", async () => {
    listMcpServers.mockResolvedValue([
      {
        id: "s1", slug: "github", name: "GitHub", url: "https://mcp.example.com",
        authMode: "static", enabled: true,
        config: { auth: { type: "bearer", token: "super-secret-token" } },
      },
    ]);

    const exported = await exportMcpServers(IID);
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain("super-secret-token");
    expect(exported[0].config).not.toHaveProperty("auth.token");
    expect((exported[0].config.auth as Record<string, unknown>)).not.toHaveProperty("token");
  });

  it("SECURITY: an oauth server export never carries the staticClient clientSecret", async () => {
    listMcpServers.mockResolvedValue([
      {
        id: "s2", slug: "linear", name: "Linear", url: "https://mcp.linear.app",
        authMode: "oauth", enabled: true,
        config: {
          scopes: ["read"],
          staticClient: { clientId: "public-id", clientSecret: "super-secret-client-secret" },
        },
      },
    ]);

    const exported = await exportMcpServers(IID);
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain("super-secret-client-secret");
    expect((exported[0].config.staticClient as Record<string, unknown>)).not.toHaveProperty("clientSecret");
    expect((exported[0].config.staticClient as Record<string, unknown>)).toMatchObject({ clientId: "public-id" });
  });

  it("SECURITY: an oauth server export never carries the dcrClient client_secret or registration_access_token", async () => {
    listMcpServers.mockResolvedValue([
      {
        id: "s4", slug: "atlassian", name: "Atlassian", url: "https://mcp.atlassian.example.com",
        authMode: "oauth", enabled: true,
        config: {
          scopes: ["read"],
          dcrClient: {
            client_id: "dcr-client-id",
            client_secret: "super-secret-dcr-client-secret",
            registration_access_token: "super-secret-registration-access-token",
          },
        },
      },
    ]);

    const exported = await exportMcpServers(IID);
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain("super-secret-dcr-client-secret");
    expect(serialized).not.toContain("super-secret-registration-access-token");
    expect(exported[0].config).not.toHaveProperty("dcrClient");
  });

  it("carries slug/name/url/authMode/enabled through unchanged", async () => {
    listMcpServers.mockResolvedValue([
      {
        id: "s3", slug: "jira", name: "Jira", url: "https://mcp.jira.example.com",
        authMode: "static", enabled: false,
        config: { auth: { type: "bearer", token: "t" } },
      },
    ]);

    const [entry] = await exportMcpServers(IID);
    expect(entry).toMatchObject({
      slug: "jira", name: "Jira", url: "https://mcp.jira.example.com", authMode: "static", enabled: false,
    });
  });
});
