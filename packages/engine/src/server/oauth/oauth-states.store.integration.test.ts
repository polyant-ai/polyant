// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * OAuth `state` nonces against a real database.
 *
 * The nonce is what ties a provider callback to the conversation that started
 * it. It is safe only while it is single-use and short-lived: a nonce that can
 * be consumed twice lets a replayed callback bind a second token, and a sweep
 * with the wrong comparison deletes every live authorization in flight. Both
 * live in the SQL, which a mocked query builder cannot evaluate. Self-skips
 * without a database; CI_REQUIRE_DB makes an absent one a failure there.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { queryClient } from "../../database/client.js";
import { resolveDatabaseAvailability } from "../../database/test-db.js";
import { consumeOAuthState, createOAuthState } from "./oauth-states.store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const MARKER = "itest-oauth-state";

const nonce = () => `${MARKER}-${randomUUID()}`;

async function create(state: string, codeVerifier: string | null = "verifier-plain"): Promise<void> {
  await createOAuthState({
    state,
    conversationId: `${MARKER}-conv`,
    instanceId: "agent",
    provider: "google",
    codeVerifier,
  });
}

describe.skipIf(!DB_AVAILABLE)("OAuth state store (integration)", () => {
  afterAll(async () => {
    await queryClient`DELETE FROM oauth_states WHERE state LIKE ${MARKER + "%"}`;
  });

  it("returns the pending authorization once, and nothing on a replay", async () => {
    const state = nonce();
    await create(state);

    expect(await consumeOAuthState(state)).toEqual({
      conversationId: `${MARKER}-conv`,
      instanceId: "agent",
      provider: "google",
      codeVerifier: "verifier-plain",
    });
    expect(await consumeOAuthState(state)).toBeNull();
  });

  it("refuses an expired nonce", async () => {
    const state = nonce();
    await create(state);
    await queryClient`UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE state = ${state}`;

    expect(await consumeOAuthState(state)).toBeNull();
  });

  it("leaves other live authorizations in place when it sweeps", async () => {
    const consumed = nonce();
    const live = nonce();
    await create(consumed);
    await create(live, null);

    await consumeOAuthState(consumed);

    expect(await consumeOAuthState(live)).toMatchObject({ provider: "google", codeVerifier: null });
  });

  it("refuses a nonce it never issued", async () => {
    expect(await consumeOAuthState(nonce())).toBeNull();
  });

  it("stores the PKCE verifier encrypted", async () => {
    const state = nonce();
    await create(state, "pkce-plaintext-marker");

    const [row] = await queryClient<{ code_verifier: string }[]>`
      SELECT code_verifier FROM oauth_states WHERE state = ${state}`;
    expect(row.code_verifier).not.toContain("pkce-plaintext-marker");
  });
});
