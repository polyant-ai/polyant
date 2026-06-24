import type { AuthenticatedUser } from "./auth.types.js";

/**
 * Parses the `x-amzn-oidc-data` header set by AWS ALB when `authenticate-oidc`
 * action is configured.
 *
 * **Trust model**: this parser does NOT verify the JWT signature. It trusts the
 * ALB layer to have already authenticated the request. Only use when:
 * 1. The ECS security group only permits inbound traffic from the ALB
 * 2. The ALB has an authenticate-oidc action in front of routing rules
 *
 * For belt-and-suspenders verification, read the `kid` from the JWT header,
 * fetch the public key from `https://public-keys.auth.elb.{region}.amazonaws.com/{kid}`,
 * and verify the ES256 signature before trusting claims.
 *
 * ALB JWT format: base64url(header).base64url(payload).base64url(signature)
 * Payload claims (Cognito OIDC): `sub`, `email`, `cognito:groups`, `name`, etc.
 */
export function parseAlbOidcData(headerValue: string): AuthenticatedUser | null {
  const parts = headerValue.split(".");
  if (parts.length !== 3) return null;

  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;

    const userId = typeof payload.sub === "string" ? payload.sub : null;
    if (!userId) return null;

    const email = typeof payload.email === "string" ? payload.email : userId;
    const name = typeof payload.name === "string" ? payload.name : undefined;

    // Cognito puts groups in "cognito:groups" claim (array of strings)
    const rawGroups = payload["cognito:groups"];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.filter((g): g is string => typeof g === "string")
      : undefined;

    // Gateway-forwarded identities are always human end-users; `orgId` is not
    // resolved in gateway mode yet (no local user row to map), so it stays absent.
    return { userId, email, name, groups, source: "alb-oidc", principalType: "user" };
  } catch {
    return null;
  }
}
