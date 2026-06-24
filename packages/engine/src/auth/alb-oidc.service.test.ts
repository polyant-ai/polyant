import { describe, it, expect } from "vitest";
import { parseAlbOidcData } from "./alb-oidc.service.js";

/**
 * Builds a fake ALB OIDC header (`header.payload.signature` base64url).
 * Signature is left as opaque junk because the parser is not expected to
 * verify it — see ADR-0001 for the trust model.
 */
function buildAlbHeader(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "test" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

describe("parseAlbOidcData", () => {
  it("returns user with sub/email/name/groups when all claims present", () => {
    const header = buildAlbHeader({
      sub: "user-123",
      email: "alice@example.com",
      name: "Alice",
      "cognito:groups": ["admins", "readers"],
    });

    expect(parseAlbOidcData(header)).toEqual({
      userId: "user-123",
      email: "alice@example.com",
      name: "Alice",
      groups: ["admins", "readers"],
      source: "alb-oidc",
      principalType: "user",
    });
  });

  it("falls back email to sub when email claim is missing", () => {
    const header = buildAlbHeader({ sub: "user-456" });

    expect(parseAlbOidcData(header)).toMatchObject({
      userId: "user-456",
      email: "user-456",
      source: "alb-oidc",
    });
  });

  it("omits name when claim is missing", () => {
    const header = buildAlbHeader({ sub: "user-789", email: "bob@example.com" });

    const result = parseAlbOidcData(header);
    expect(result?.name).toBeUndefined();
  });

  it("filters non-string entries out of cognito:groups", () => {
    const header = buildAlbHeader({
      sub: "user-1",
      "cognito:groups": ["admins", 42, null, "readers"],
    });

    expect(parseAlbOidcData(header)?.groups).toEqual(["admins", "readers"]);
  });

  it("returns undefined groups when cognito:groups is not an array", () => {
    const header = buildAlbHeader({ sub: "user-1", "cognito:groups": "admins" });

    expect(parseAlbOidcData(header)?.groups).toBeUndefined();
  });

  it("returns null when sub claim is missing", () => {
    const header = buildAlbHeader({ email: "noone@example.com" });

    expect(parseAlbOidcData(header)).toBeNull();
  });

  it("returns null when sub is not a string", () => {
    const header = buildAlbHeader({ sub: 12345, email: "x@example.com" });

    expect(parseAlbOidcData(header)).toBeNull();
  });

  it("returns null when header has fewer than 3 dot-separated parts", () => {
    expect(parseAlbOidcData("header.payload")).toBeNull();
    expect(parseAlbOidcData("only-one-part")).toBeNull();
  });

  it("returns null when header has more than 3 dot-separated parts", () => {
    expect(parseAlbOidcData("a.b.c.d")).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(parseAlbOidcData("")).toBeNull();
  });

  it("returns null when payload is not valid base64url JSON", () => {
    expect(parseAlbOidcData("header.!!!not-base64-json!!!.sig")).toBeNull();
  });

  it("returns null when payload decodes to non-JSON", () => {
    const garbage = Buffer.from("not json at all").toString("base64url");
    expect(parseAlbOidcData(`header.${garbage}.sig`)).toBeNull();
  });
});
