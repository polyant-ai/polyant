// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import {
  buildAuthorizeUrl,
  generatePkcePair,
  getOAuthProvider,
  knownProviderNames,
  oauthSecretKeys,
  resolveClientId,
} from "./oauth-providers.js";
import { oauthRequiredSecrets } from "../../agents/tools/oauth-access.js";

describe("oauth broker authorize URL", () => {
  it("should_register_github_and_google", () => {
    expect(knownProviderNames()).toEqual(expect.arrayContaining(["github", "google"]));
  });

  it("should_carry_the_state_nonce_and_a_provider_scoped_callback", () => {
    const gh = getOAuthProvider("github")!;
    const url = new URL(buildAuthorizeUrl(gh, "nonce-abc", "cid-123"));

    expect(url.searchParams.get("state")).toBe("nonce-abc");
    expect(url.searchParams.get("client_id")).toBe("cid-123");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/oauth\/github\/callback$/);
    // No PKCE params when no challenge is passed.
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });

  it("should_add_pkce_params_when_a_challenge_is_provided", () => {
    const google = getOAuthProvider("google")!;
    const url = new URL(buildAuthorizeUrl(google, "n", "cid", "chal-xyz"));
    expect(url.searchParams.get("code_challenge")).toBe("chal-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("should_derive_the_pkce_challenge_as_s256_of_the_verifier", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("should_apply_google_offline_access_params", () => {
    const google = getOAuthProvider("google")!;
    const url = new URL(buildAuthorizeUrl(google, "c:1", "cid"));

    expect(url.searchParams.get("redirect_uri")).toMatch(/\/oauth\/google\/callback$/);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("oauth broker credential resolution", () => {
  it("should_prefer_per_instance_client_id_over_env", () => {
    const { clientIdKey } = oauthSecretKeys("github");
    // Per-instance secret wins over any env fallback.
    expect(resolveClientId("github", { [clientIdKey]: "per-instance" })).toBe("per-instance");
  });

  it("should_return_undefined_when_no_secret_present", () => {
    expect(resolveClientId("github", {})).toBeUndefined();
  });

  it("should_declare_client_id_readable_and_client_secret_masked", () => {
    // Tools declare a provider's credentials via oauthRequiredSecrets. The
    // Settings UI renders sensitive:false in cleartext, so the public client_id
    // must be readable and the client_secret masked.
    for (const name of knownProviderNames()) {
      const specs = new Map(oauthRequiredSecrets(name).map((s) => [s.key, s]));
      const { clientIdKey, clientSecretKey } = oauthSecretKeys(name);
      expect(specs.get(clientIdKey)?.sensitive).toBe(false);
      expect(specs.get(clientSecretKey)?.sensitive).toBe(true);
    }
  });
});
