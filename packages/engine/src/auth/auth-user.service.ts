// SPDX-License-Identifier: AGPL-3.0-or-later

import { hkdf } from "@panva/hkdf";
import { jwtDecrypt } from "jose";
import type { AuthenticatedUser } from "./auth.types.js";
import { config } from "../config.js";

const AUTH_SECRET = config.auth.secret;

/**
 * Auth.js cookie names — the name is also used as HKDF salt for key derivation.
 * In production (HTTPS), Auth.js prefixes with "__Secure-".
 */
const SESSION_COOKIE_SALTS = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
] as const;

/**
 * Derives the encryption key from AUTH_SECRET, matching Auth.js internal logic.
 * Auth.js uses HKDF with the cookie name as salt and A256CBC-HS512 (64 bytes).
 * Memoized per salt — the secret is process-stable, so the derived key is too.
 */
const derivedKeyCache = new Map<string, Uint8Array>();
async function getDerivedEncryptionKey(secret: string, salt: string): Promise<Uint8Array> {
  const cached = derivedKeyCache.get(salt);
  if (cached) return cached;
  const key = new Uint8Array(
    await hkdf("sha256", secret, salt, `Auth.js Generated Encryption Key (${salt})`, 64),
  );
  derivedKeyCache.set(salt, key);
  return key;
}

/**
 * Validates an Auth.js JWT session token.
 * Auth.js encrypts JWTs using JWE (A256CBC-HS512) with a key derived from AUTH_SECRET.
 * Tries both cookie name salts (HTTP and HTTPS variants) since the salt must match
 * the cookie name Auth.js used when encrypting.
 */
export async function validateSessionToken(
  sessionToken: string,
  cookieName?: string,
): Promise<AuthenticatedUser | null> {
  // If the caller tells us which cookie name was used, try that salt first
  const salts = cookieName
    ? [cookieName, ...SESSION_COOKIE_SALTS.filter((s) => s !== cookieName)]
    : [...SESSION_COOKIE_SALTS];

  for (const salt of salts) {
    try {
      const encryptionKey = await getDerivedEncryptionKey(AUTH_SECRET, salt);
      const { payload } = await jwtDecrypt(sessionToken, encryptionKey, {
        clockTolerance: 15,
        contentEncryptionAlgorithms: ["A256CBC-HS512", "A256GCM"],
        keyManagementAlgorithms: ["dir"],
      });

      if (!payload.sub && !payload.email) return null;

      const role = payload.role === "superadmin" ? "superadmin" : "user";
      const mustChangePassword = payload.mustChangePassword === true;
      // Only trust a string `orgId` claim; anything else is treated as absent so
      // a malformed token never leaks a non-string value downstream.
      const orgId = typeof payload.orgId === "string" ? payload.orgId : undefined;

      return {
        userId: (payload.sub ?? payload.id) as string,
        email: payload.email as string,
        name: (payload.name as string) ?? undefined,
        role,
        mustChangePassword,
        principalType: "user",
        orgId,
      };
    } catch {
      // Try next salt
    }
  }

  return null;
}
