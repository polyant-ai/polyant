// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { maskMcpConfig, mergeMaskedMcpSecrets, MCP_SECRET_SUBTREES } from "./mcp-config-mask.js";

const MASK = "••••";

describe("maskMcpConfig", () => {
  it("masks the static bearer token to MASK+last4", () => {
    const masked = maskMcpConfig("static", { auth: { type: "bearer", token: "abcdef123456" } });
    expect(masked).toEqual({ auth: { type: "bearer", token: `${MASK}3456` } });
  });

  it("returns a `none` config untouched", () => {
    expect(maskMcpConfig("none", { allowList: ["a"] })).toEqual({ allowList: ["a"] });
  });

  it("does not return any DCR credential in cleartext (registration_access_token included)", () => {
    const config = {
      staticClient: { clientId: "cid", clientSecret: "sekret-9999" },
      dcrClient: {
        client_id: "dcr-client",
        client_secret: "dcr-secret-1111",
        registration_access_token: "rat-super-secret-2222",
        registration_client_uri: "https://as.example.com/register/dcr-client",
      },
    };

    const masked = maskMcpConfig("oauth", config);
    const serialized = JSON.stringify(masked);

    expect(serialized).not.toContain("rat-super-secret-2222");
    expect(serialized).not.toContain("dcr-secret-1111");
    expect(serialized).not.toContain("https://as.example.com/register/dcr-client");
    expect(masked.staticClient).toEqual({ clientId: "cid", clientSecret: `${MASK}9999` });
    // Every leaf of the subtree is redacted, whatever the authorization server named it.
    for (const value of Object.values(masked.dcrClient as Record<string, unknown>)) {
      expect(String(value).startsWith(MASK)).toBe(true);
    }
    // The original object is never mutated.
    expect(config.dcrClient.registration_access_token).toBe("rat-super-secret-2222");
  });

  it("declares dcrClient as a secret subtree (single source of truth shared with the export stripper)", () => {
    expect(MCP_SECRET_SUBTREES.oauth).toEqual([["dcrClient"]]);
    expect(MCP_SECRET_SUBTREES.none).toEqual([]);
    expect(MCP_SECRET_SUBTREES.static).toEqual([]);
  });
});

describe("mergeMaskedMcpSecrets", () => {
  it("restores a masked static token from the existing config", () => {
    const merged = mergeMaskedMcpSecrets(
      "static",
      { auth: { type: "bearer", token: `${MASK}3456` } },
      { auth: { type: "bearer", token: "abcdef123456" } },
    );
    expect(merged).toEqual({ auth: { type: "bearer", token: "abcdef123456" } });
  });

  it("restores the whole dcrClient subtree when the client echoes back masked leaves", () => {
    const existing = { dcrClient: { client_id: "cid", registration_access_token: "rat-2222" } };
    const merged = mergeMaskedMcpSecrets(
      "oauth",
      { dcrClient: { client_id: `${MASK}cid`, registration_access_token: `${MASK}2222` } },
      existing,
    );
    expect(merged.dcrClient).toEqual(existing.dcrClient);
  });

  it("restores the dcrClient subtree when the client omits it entirely", () => {
    const existing = { dcrClient: { client_id: "cid" } };
    const merged = mergeMaskedMcpSecrets("oauth", { scopes: ["read"] }, existing);
    expect(merged).toEqual({ scopes: ["read"], dcrClient: { client_id: "cid" } });
  });

  it("keeps a genuinely new dcrClient submitted by the client", () => {
    const merged = mergeMaskedMcpSecrets("oauth", { dcrClient: { client_id: "new" } }, { dcrClient: { client_id: "old" } });
    expect(merged.dcrClient).toEqual({ client_id: "new" });
  });
});
