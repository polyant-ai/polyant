// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";

// What the store writes and lists runs on Postgres in mcp-servers.store.integration.test.ts;
// this file covers the config schema, which needs no database.
import { mcpServerConfigSchema } from "./mcp-servers.store.js";

describe("mcp-servers.store", () => {
  it("should_reject_static_config_without_auth", () => {
    expect(() => mcpServerConfigSchema("static", { allowList: [] })).toThrow();
  });

  it("should_accept_a_none_config_carrying_only_an_allow_list", () => {
    expect(mcpServerConfigSchema("none", { allowList: ["search"] })).toEqual({ allowList: ["search"] });
    expect(mcpServerConfigSchema("none", {})).toEqual({});
  });

  // The whole point of the mode: nothing to store. A leftover token from a mode
  // switch must be a 400, not a secret quietly persisted for a server that will
  // never send it.
  it("should_reject_a_credential_sent_with_authMode_none", () => {
    expect(() => mcpServerConfigSchema("none", { auth: { type: "bearer", token: "sh-x" } })).toThrow();
  });

  it("should_accept_oauth_config_with_only_scopes", () => {
    expect(mcpServerConfigSchema("oauth", { scopes: ["repo"] })).toMatchObject({ scopes: ["repo"] });
  });

  /*
    `server.url` gets the SSRF guard; `authServerInfo` and `dcrClient` steer the
    same OAuth client and got none, while `dcrClient` was an open record — so a
    crafted import bundle (or a hand-written PUT) could point the flow at an
    internal host, and `clientInformation()` prefers `dcrClient` over
    `staticClient`. The metadata the SDK writes back goes through this schema
    too, so the check is production-only: a developer's localhost MCP server
    must stay configurable.
  */
  describe("oauth endpoints that the flow will request", () => {
    it("should_reject_an_authServerInfo_pointing_at_a_private_host_in_production", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(() =>
        mcpServerConfigSchema("oauth", {
          authServerInfo: {
            authorizationServerUrl: "https://169.254.169.254/authorize",
            tokenEndpoint: "https://auth.example.com/token",
          },
        }),
      ).toThrow();
      vi.unstubAllEnvs();
    });

    it("should_reject_a_dcrClient_endpoint_pointing_at_a_metadata_host_in_production", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(() =>
        mcpServerConfigSchema("oauth", {
          dcrClient: { client_id: "abc", token_endpoint: "https://metadata.google.internal/token" },
        }),
      ).toThrow();
      vi.unstubAllEnvs();
    });

    it("should_accept_public_oauth_endpoints_and_strip_unknown_dcrClient_keys", () => {
      vi.stubEnv("NODE_ENV", "production");
      const parsed = mcpServerConfigSchema("oauth", {
        authServerInfo: {
          authorizationServerUrl: "https://auth.example.com/authorize",
          tokenEndpoint: "https://auth.example.com/token",
        },
        dcrClient: { client_id: "abc", client_secret: "s3cret", redirect_uris: ["https://evil.example/cb"] },
      });
      expect(parsed).toMatchObject({
        authServerInfo: { tokenEndpoint: "https://auth.example.com/token" },
        dcrClient: { client_id: "abc", client_secret: "s3cret" },
      });
      expect((parsed as { dcrClient: Record<string, unknown> }).dcrClient).not.toHaveProperty("redirect_uris");
      vi.unstubAllEnvs();
    });

    it("should_reject_a_dcrClient_without_a_client_id", () => {
      expect(() => mcpServerConfigSchema("oauth", { dcrClient: { client_secret: "s3cret" } })).toThrow();
    });
  });
});
