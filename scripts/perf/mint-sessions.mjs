#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Mints Auth.js-compatible session tokens (JWE, A256CBC-HS512, HKDF with the
// cookie name as salt) for the perf users, so k6 can call the engine as real
// signed-in users. Needs AUTH_SECRET, the engine's own.
// Usage: node mint-sessions.mjs < users.tsv > sessions.json
// users.tsv: user_id<TAB>email<TAB>org_slug<TAB>org_id per line. The orgId claim
// is how a single-organization deployment picks the tenant when the database
// holds several organizations.
import { hkdf } from "node:crypto";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(new URL("../../packages/engine/package.json", import.meta.url));
const { EncryptJWT } = require("jose");

const SALT = "authjs.session-token";
const secret = process.env.AUTH_SECRET;
if (!secret) {
  console.error("AUTH_SECRET is not set");
  process.exit(1);
}
const key = new Uint8Array(
  await promisify(hkdf)("sha256", secret, SALT, `Auth.js Generated Encryption Key (${SALT})`, 64),
);

const out = [];
for (const line of readFileSync(0, "utf8").trim().split("\n")) {
  const [userId, email, org, orgId] = line.split("\t");
  const token = await new EncryptJWT({ sub: userId, email, name: email, signInMethod: "credentials", ...(orgId ? { orgId } : {}) })
    .setProtectedHeader({ alg: "dir", enc: "A256CBC-HS512" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .encrypt(key);
  out.push({ userId, email, org, cookie: `${SALT}=${token}` });
}
process.stdout.write(JSON.stringify(out));
