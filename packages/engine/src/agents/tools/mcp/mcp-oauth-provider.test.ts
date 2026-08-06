// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OAuthClientProvider } from "@ai-sdk/mcp";
import { asAgentUuid, asAgentSlug } from "../../../instances/identifiers.js";

const vault = new Map<string, string>();
// Captures the raw args every setPrincipalSecret call was made with, so tests can
// assert on the exact `instanceId` value passed (slug vs uuid — Defect C).
const setPrincipalSecretCalls: Array<{ scopeKey: string; instanceId: unknown; key: string }> = [];
vi.mock("../../../conversations/principal-secrets.store.js", () => ({
  setPrincipalSecret: vi.fn(async (scopeKey: string, instanceId: unknown, key: string, value: string) => {
    setPrincipalSecretCalls.push({ scopeKey, instanceId, key });
    vault.set(`${scopeKey}:${key}`, value);
  }),
  getPrincipalSecret: vi.fn(async (scopeKey: string, key: string) => {
    const v = vault.get(`${scopeKey}:${key}`);
    return v ? { value: v, expiresAt: null } : undefined;
  }),
}));
const states: Array<{ state: string; conversationId: string; instanceId: string; provider: string }> = [];
vi.mock("../../../server/oauth/oauth-states.store.js", () => ({
  createOAuthState: vi.fn(async (row: { state: string; conversationId: string; instanceId: string; provider: string }) => {
    states.push(row);
  }),
  consumeOAuthState: vi.fn(async (s: string) => states.find((r) => r.state === s) ?? null),
}));
const merged: Array<{ slug: string; patch: Record<string, unknown> }> = [];
vi.mock("../../../instances/mcp-servers.store.js", () => ({
  mergeMcpServerConfig: vi.fn(async (_i: unknown, slug: string, patch: Record<string, unknown>) => {
    merged.push({ slug, patch });
  }),
}));
vi.mock("../../../config.js", () => ({ config: { server: { baseUrl: "https://polyant.test", port: 4000 } } }));

const { makeMcpOAuthProvider, mcpRedirectUrl } = await import("./mcp-oauth-provider.js");
// instanceUuid and instanceSlug are deliberately different strings so a test
// asserting "the slug was used" cannot pass by accident if the uuid were used instead.
const deps = { instanceUuid: asAgentUuid("iid"), instanceSlug: asAgentSlug("my-slug"), conversationId: "conv-1", serverSlug: "gh", config: {} as any };

describe("McpVaultOAuthProvider", () => {
  beforeEach(() => {
    vault.clear();
    states.length = 0;
    merged.length = 0;
    setPrincipalSecretCalls.length = 0;
  });

  it("should_build_redirect_url", () => {
    expect(mcpRedirectUrl()).toBe("https://polyant.test/mcp/oauth/callback");
  });

  it("should_conform_to_the_real_OAuthClientProvider_interface", () => {
    const p: OAuthClientProvider = makeMcpOAuthProvider(deps);
    expect(p).toBeDefined();
  });

  it("should_round_trip_tokens_via_vault_per_conversation", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveTokens({ access_token: "at", token_type: "bearer" } as any);
    expect(await p.tokens()).toMatchObject({ access_token: "at" });
    expect(vault.has("conv-1:mcp_gh_tokens")).toBe(true);
  });

  // Defect C: deleteInstance()'s cascade deletes principal_secrets BY SLUG
  // (instances/store.ts), matching every other setPrincipalSecret caller
  // (oauth-token-service.ts, oauth-callback.controller.ts). Passing the uuid here
  // orphans the row permanently on instance deletion.
  it("should_key_saveTokens_by_instance_slug_not_uuid", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveTokens({ access_token: "at", token_type: "bearer" } as any);
    expect(setPrincipalSecretCalls).toContainEqual(
      expect.objectContaining({ instanceId: "my-slug", key: "mcp_gh_tokens" }),
    );
  });

  it("should_key_saveCodeVerifier_by_instance_slug_not_uuid", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveCodeVerifier("verifier-abc");
    expect(setPrincipalSecretCalls).toContainEqual(
      expect.objectContaining({ instanceId: "my-slug", key: "mcp_gh_verifier" }),
    );
  });

  it("should_persist_dcr_client_to_server_config", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveClientInformation!({ client_id: "cid" } as any);
    expect(merged[0]).toMatchObject({ slug: "gh", patch: { dcrClient: { client_id: "cid" } } });
  });

  it("should_generate_a_fresh_nonce_via_state_and_not_persist_until_saveState", async () => {
    // Step 0 finding: the SDK's auth() only calls saveState() when provider.state()
    // returns a truthy value first (`const state = provider.state ? await provider.state() : void 0;
    // if (state && provider.saveState) await provider.saveState(state);`). Without a state()
    // method, saveState() is unreachable and no CSRF row is ever created.
    const p = makeMcpOAuthProvider(deps);
    const s1 = await p.state!();
    const s2 = await p.state!();
    expect(typeof s1).toBe("string");
    expect(s1.length).toBeGreaterThan(0);
    expect(s1).not.toBe(s2);
    expect(states.length).toBe(0); // state() alone must not persist anything
  });

  it("should_capture_authorize_url_and_persist_state", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveState!("nonce-123");
    await p.redirectToAuthorization(new URL("https://gh.test/authorize?x=1"));
    expect(p.pendingAuthorizeUrl).toBe("https://gh.test/authorize?x=1");
    expect(states[0]).toMatchObject({ state: "nonce-123", conversationId: "conv-1", provider: "mcp:gh" });
  });

  it("should_match_storedState_to_setStoredState_across_a_fresh_instance", async () => {
    // Simulates the callback (Task 9): a new provider instance is constructed for the
    // request, then seeded from the consumed oauth_states row before auth() reads storedState().
    const p = makeMcpOAuthProvider(deps);
    p.setStoredState("nonce-123");
    expect(await p.storedState!()).toBe("nonce-123");
  });

  it("should_read_client_from_staticClient_when_no_dcr", async () => {
    const p = makeMcpOAuthProvider({ ...deps, config: { staticClient: { clientId: "static-cid", clientSecret: "sek" } } as any });
    expect(await p.clientInformation()).toMatchObject({ client_id: "static-cid", client_secret: "sek" });
  });

  it("should_always_request_a_public_client_via_dcr", () => {
    const p = makeMcpOAuthProvider(deps);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("should_persist_authorization_server_information_to_server_config_not_client_information", async () => {
    const p = makeMcpOAuthProvider(deps);
    await p.saveAuthorizationServerInformation!({ authorizationServerUrl: "https://gh.test", tokenEndpoint: "https://gh.test/token" });
    expect(merged[0]).toMatchObject({
      slug: "gh",
      patch: { authServerInfo: { authorizationServerUrl: "https://gh.test", tokenEndpoint: "https://gh.test/token" } },
    });
  });

  it("should_read_authorization_server_information_from_server_config", async () => {
    const authServerInfo = { authorizationServerUrl: "https://gh.test", tokenEndpoint: "https://gh.test/token" };
    const p = makeMcpOAuthProvider({ ...deps, config: { authServerInfo } as any });
    expect(await p.authorizationServerInformation!()).toEqual(authServerInfo);
  });
});
