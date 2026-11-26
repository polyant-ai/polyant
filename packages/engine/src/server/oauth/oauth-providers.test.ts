// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, beforeEach, vi } from "vitest";
import { createHash } from "crypto";
import {
  buildAuthorizeUrl,
  generatePkcePair,
  getOAuthProvider,
  hasOAuthProvider,
  knownProviderNames,
  oauthRefreshStateKey,
  oauthSecretKeys,
  oauthTokenStateKey,
  registerOAuthProvider,
  resolveClientId,
  _resetOAuthRegistryForTests,
  type OAuthProvider,
} from "./oauth-providers.js";
import { oauthRequiredSecrets } from "../../agents/tools/oauth-access.js";

// The platform policies are a row; this suite has no database. The values are
// the shipped defaults, so the assertions read the same as before they moved.
vi.mock("../../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: async () => ({ baseUrl: "http://localhost:4000" }),
}));

const GH: OAuthProvider = {
  name: "github",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scope: "repo read:user",
  extraAuthorizeParams: { allow_signup: "false" },
  pkce: false,
};
const GOOGLE: OAuthProvider = {
  name: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "openid email",
  extraAuthorizeParams: { response_type: "code", access_type: "offline", prompt: "consent" },
  pkce: true,
};

beforeEach(() => {
  _resetOAuthRegistryForTests();
});

describe("registerOAuthProvider", () => {
  it("should_start_empty", () => {
    expect(knownProviderNames()).toEqual([]);
  });

  it("should_register_and_look_up_by_name", () => {
    registerOAuthProvider(GH);
    expect(getOAuthProvider("github")).toEqual(GH);
    expect(knownProviderNames()).toEqual(["github"]);
  });

  it("should_dedup_an_identical_re_registration", () => {
    registerOAuthProvider(GH);
    // Same definition, key order in extraAuthorizeParams irrelevant → no-op, no throw.
    registerOAuthProvider({ ...GH, extraAuthorizeParams: { allow_signup: "false" } });
    expect(knownProviderNames()).toEqual(["github"]);
  });

  it("should_fail_loud_on_a_divergent_same_name_definition", () => {
    registerOAuthProvider(GH);
    expect(() => registerOAuthProvider({ ...GH, scope: "repo" })).toThrow(/OAuth provider conflict "github"/);
  });
});

describe("oauth broker authorize URL", () => {
  beforeEach(() => {
    registerOAuthProvider(GH);
    registerOAuthProvider(GOOGLE);
  });

  it("should_carry_the_state_nonce_and_a_provider_scoped_callback", async () => {
    const url = new URL(await buildAuthorizeUrl(getOAuthProvider("github")!, "nonce-abc", "cid-123"));
    expect(url.searchParams.get("state")).toBe("nonce-abc");
    expect(url.searchParams.get("client_id")).toBe("cid-123");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/oauth\/github\/callback$/);
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });

  it("should_add_pkce_params_when_a_challenge_is_provided", async () => {
    const url = new URL(await buildAuthorizeUrl(getOAuthProvider("google")!, "n", "cid", "chal-xyz"));
    expect(url.searchParams.get("code_challenge")).toBe("chal-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("should_derive_the_pkce_challenge_as_s256_of_the_verifier", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("should_apply_google_offline_access_params", async () => {
    const url = new URL(await buildAuthorizeUrl(getOAuthProvider("google")!, "c:1", "cid"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("oauth broker credential resolution", () => {
  it("should_prefer_per_instance_client_id", () => {
    const { clientIdKey } = oauthSecretKeys("github");
    expect(resolveClientId("github", { [clientIdKey]: "per-instance" })).toBe("per-instance");
  });

  it("should_return_undefined_when_no_secret_present", () => {
    expect(resolveClientId("github", {})).toBeUndefined();
  });

  it("should_declare_client_id_readable_and_client_secret_masked", () => {
    const specs = new Map(oauthRequiredSecrets("github").map((s) => [s.key, s]));
    const { clientIdKey, clientSecretKey } = oauthSecretKeys("github");
    expect(specs.get(clientIdKey)?.sensitive).toBe(false);
    expect(specs.get(clientSecretKey)?.sensitive).toBe(true);
  });
});

describe("provider scopes", () => {
  const elsewhere = (authorizeUrl: string): OAuthProvider => ({ ...GH, authorizeUrl });

  it("should_resolve_and_key_exactly_as_before_without_a_scope", () => {
    registerOAuthProvider(GH);
    expect(getOAuthProvider("github")).toEqual(GH);
    expect(getOAuthProvider("github", null)).toEqual(GH);
    expect(oauthTokenStateKey("github")).toBe("github_oauth_token");
    expect(oauthRefreshStateKey("github")).toBe("github_oauth_refresh");
    expect(knownProviderNames()).toEqual(["github"]);
  });

  it("should_keep_a_scoped_provider_apart_from_the_shared_one_of_the_same_name_whichever_registers_first", () => {
    registerOAuthProvider(elsewhere("https://a.example/authorize"), "scope-a");
    expect(() => registerOAuthProvider(GH)).not.toThrow();

    expect(getOAuthProvider("github")).toEqual(GH);
    expect(getOAuthProvider("github", "scope-a")?.authorizeUrl).toBe("https://a.example/authorize");
    expect(knownProviderNames()).toEqual(["github"]);
  });

  it("should_keep_two_scopes_apart_and_never_fall_back_to_the_shared_registry", () => {
    registerOAuthProvider(GH);
    registerOAuthProvider(elsewhere("https://a.example/authorize"), "scope-a");
    registerOAuthProvider(elsewhere("https://b.example/authorize"), "scope-b");

    expect(getOAuthProvider("github", "scope-a")?.authorizeUrl).toBe("https://a.example/authorize");
    expect(getOAuthProvider("github", "scope-b")?.authorizeUrl).toBe("https://b.example/authorize");
    expect(getOAuthProvider("github", "scope-c")).toBeUndefined();
    expect(getOAuthProvider("google", "scope-a")).toBeUndefined();
  });

  it("should_still_reject_a_divergent_definition_inside_one_scope", () => {
    registerOAuthProvider(GH, "scope-a");
    expect(() => registerOAuthProvider({ ...GH, scope: "repo" }, "scope-a")).toThrow(/OAuth provider conflict "github"/);
  });

  it("should_know_a_name_held_only_in_a_scoped_registry", () => {
    expect(hasOAuthProvider("github")).toBe(false);
    registerOAuthProvider(GH, "scope-a");
    expect(hasOAuthProvider("github")).toBe(true);
    expect(hasOAuthProvider("git")).toBe(false);
    expect(knownProviderNames()).toEqual([]);
  });

  it("should_store_a_scoped_provider's_tokens_under_keys_of_their_own", () => {
    expect(oauthTokenStateKey("github", "scope-a")).toBe("scope-a:github_oauth_token");
    expect(oauthRefreshStateKey("github", "scope-a")).toBe("scope-a:github_oauth_refresh");
    expect(oauthTokenStateKey("github", "scope-a")).not.toBe(oauthTokenStateKey("github", "scope-b"));
  });
});
