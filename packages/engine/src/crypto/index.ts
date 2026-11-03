// SPDX-License-Identifier: AGPL-3.0-or-later

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";
import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  return Buffer.from(config.encryption.key, "hex");
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function decrypt(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivB64, tagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf-8");
}

/**
 * A keyed, deterministic digest of a secret, for finding the row that stores it
 * without decrypting every candidate. Keyed so that a copy of the database
 * alone does not allow guessing a short secret offline; the key is derived from
 * the encryption key, so it is never the one AES uses.
 */
export function lookupDigest(secret: string): string {
  const key = createHmac("sha256", getKey()).update("polyant:secret-lookup-digest").digest();
  return createHmac("sha256", key).update(secret, "utf-8").digest("hex");
}
