// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug, asInstanceUuid } from "../../../instances/identifiers.js";

const store = {
  getMcpSharedTokens: vi.fn(),
  saveMcpSharedTokens: vi.fn(),
  clearMcpSharedTokens: vi.fn(),
  mergeMcpServerConfig: vi.fn(),
};
vi.mock("../../../instances/mcp-servers.store.js", () => store);
const createOAuthState = vi.fn();
vi.mock("../../../server/oauth/oauth-states.store.js", () => ({ createOAuthState }));
// The parent's conversation vault: a shared account must never touch it.
const principalSecrets = { getPrincipalSecret: vi.fn(), setPrincipalSecret: vi.fn() };
vi.mock("../../../conversations/principal-secrets.store.js", () => principalSecrets);

const { McpSharedOAuthProvider, McpSharedAccountNotConnectedError } = await import("./mcp-shared-oauth-provider.js");

const deps = {
  baseUrl: "https://polyant.test",
  instanceUuid: asInstanceUuid("iid"),
  instanceSlug: asInstanceSlug("agent"),
  serverSlug: "linear",
  config: { account: "shared" } as never,
};

describe("McpSharedOAuthProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("during a turn", () => {
    const provider = () => new McpSharedOAuthProvider({ ...deps, mode: { kind: "turn" } });

    it("reads the agent's tokens and writes a refresh back without changing who connected", async () => {
      store.getMcpSharedTokens.mockResolvedValue('{"access_token":"at-1"}');
      const p = provider();

      expect(await p.tokens()).toEqual({ access_token: "at-1" });
      await p.saveTokens({ access_token: "at-2", token_type: "Bearer" });

      expect(store.saveMcpSharedTokens).toHaveBeenCalledWith("iid", "linear", '{"access_token":"at-2","token_type":"Bearer"}', undefined);
      expect(principalSecrets.setPrincipalSecret).not.toHaveBeenCalled();
    });

    it("refuses to start an authorization, so no conversation gets a link to the agent's account", async () => {
      const p = provider();
      await p.saveState(await p.state());
      await expect(p.saveCodeVerifier("v")).rejects.toBeInstanceOf(McpSharedAccountNotConnectedError);
      expect(createOAuthState).not.toHaveBeenCalled();
    });

    it("forgets the account when the provider says the grant is dead", async () => {
      await provider().invalidateCredentials("tokens");
      expect(store.clearMcpSharedTokens).toHaveBeenCalledWith("iid", "linear", undefined);
    });

    it("forgets only the tokens the refused refresh used", async () => {
      const tokens = { access_token: "at-1", refresh_token: "rt-1", token_type: "Bearer" };
      await provider().invalidateCredentials("tokens", { tokens });
      expect(store.clearMcpSharedTokens).toHaveBeenCalledWith("iid", "linear", tokens);
    });
  });

  it("ignores stored tokens when an admin connects again, so the provider is always asked", async () => {
    store.getMcpSharedTokens.mockResolvedValue('{"access_token":"at-1"}');
    const p = new McpSharedOAuthProvider({ ...deps, mode: { kind: "authorize", actorUserId: "u1" } });
    expect(await p.tokens()).toBeUndefined();
  });
});
