// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The parts of the management API key store that need no database: reading a
 * token, the digest of a secret, and refusing a malformed token or id before
 * any query. Validation, the legacy bcrypt rehash, last use, expiry, listing and
 * revocation run on Postgres in management-api-keys.store.integration.test.ts.
 */

import { describe, it, expect, vi } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn() },
}));
vi.mock("../database/client.js", () => ({ db: mockDb }));

import { createHash } from "node:crypto";
import {
  deleteManagementApiKey,
  hashManagementApiKeySecret,
  parseManagementApiKeyToken,
  validateManagementApiKey,
} from "./management-api-keys.store.js";

const VALID_ID = "11111111-1111-1111-1111-111111111111";

describe("parseManagementApiKeyToken", () => {
  it("parses pk_<id>_<secret> into id and secret", () => {
    const parsed = parseManagementApiKeyToken(`pk_${VALID_ID}_super-secret`);
    expect(parsed).toEqual({ id: VALID_ID, secret: "super-secret" });
  });

  it("returns null for a token without the pk_ prefix", () => {
    expect(parseManagementApiKeyToken(`${VALID_ID}_secret`)).toBeNull();
  });

  it("returns null when the secret segment is missing", () => {
    expect(parseManagementApiKeyToken(`pk_${VALID_ID}`)).toBeNull();
  });

  it("returns null for an empty token", () => {
    expect(parseManagementApiKeyToken("")).toBeNull();
  });

  // The id is a uuid column. Any other value made Postgres raise a cast error,
  // logged at error level, on every anonymous request that sent one.
  it("returns null when the id is not a uuid", () => {
    expect(parseManagementApiKeyToken("pk_x_y")).toBeNull();
    expect(parseManagementApiKeyToken("pk_1111-2222_secret")).toBeNull();
  });
});

describe("refused before any query", () => {
  it("validates no malformed token", async () => {
    expect(await validateManagementApiKey("not-a-valid-token")).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("deletes nothing for an id that is not a uuid", async () => {
    expect(await deleteManagementApiKey("org-1", "not-a-uuid")).toBe(false);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

// bcrypt at cost 12 takes about 250 ms of event-loop time, and it ran on every
// request a management key authenticated. The secret is 32 random bytes, which
// a slow hash adds nothing to, so a SHA-256 digest is stored instead.
describe("hashManagementApiKeySecret", () => {
  it("hashes a secret as a SHA-256 digest", () => {
    expect(hashManagementApiKeySecret("s3cret")).toBe(`sha256:${createHash("sha256").update("s3cret").digest("hex")}`);
  });
});
