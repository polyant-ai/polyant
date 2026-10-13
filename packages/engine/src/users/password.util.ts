// SPDX-License-Identifier: AGPL-3.0-or-later

import bcrypt from "bcryptjs";

/**
 * bcrypt cost factor. 12 rounds ≈ 250ms per hash on a modern CPU — slow enough
 * to make brute-force expensive without hurting interactive login UX. Don't
 * tune below 10 or above 14 unless you've benchmarked the target environment.
 */
export const PASSWORD_HASH_COST = 12;

let cost = PASSWORD_HASH_COST;

/**
 * Lower the cost for a test process. The suite hashes hundreds of passwords,
 * and at the production cost that alone took several seconds of CPU per file.
 * The cost is recorded inside every hash, so verifying is unaffected. Only
 * `test-setup.ts` calls this; `password.util.test.ts` checks that a hash made
 * at the default cost carries PASSWORD_HASH_COST.
 */
export function setPasswordHashCostForTests(rounds: number): void {
  cost = rounds;
}

const MIN_LENGTH = 8;

export interface PasswordValidationError {
  code: "too_short";
  message: string;
}

export function validatePassword(plain: string): PasswordValidationError | null {
  if (typeof plain !== "string" || plain.length < MIN_LENGTH) {
    return { code: "too_short", message: `Password must be at least ${MIN_LENGTH} characters` };
  }
  return null;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, cost);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
