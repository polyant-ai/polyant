// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Provider } from "@auth/core/providers";

/**
 * The federated (single sign-on) providers this build offers, as an Auth.js
 * provider list. **This edition offers none**, and the empty array is the whole
 * implementation.
 *
 * It is a module rather than an empty literal inside `auth.config.ts` because it
 * is a SEAM. Single sign-on is an enterprise capability: the enterprise build
 * supplies its own copy of this file returning the providers it supports, and
 * `auth.config.ts` — a file both editions share — stays byte-identical between
 * them. Removing the provider from the shared config instead would put a
 * permanent conflict in the middle of the file that holds every other
 * authentication decision.
 *
 * What used to be here, and why it left: a Google provider built from
 * `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, with a domain allowlist read from
 * `AUTH_ALLOWED_DOMAIN(S)`. One domain list for a whole installation cannot
 * answer "who may sign in" for a second tenant, and the question belongs to the
 * organization — a tier this edition does not manage. Both variables are gone;
 * see `docs/UPGRADING.md`.
 *
 * Email and password is therefore the only way in here, and the account that
 * opens it is seeded from `INITIAL_ADMIN_PASSWORD` at first boot.
 */
export function federatedProviders(): Provider[] {
  return [];
}

/**
 * Whether the login page should offer a federated sign-in button at all.
 * Always false in this edition, which is why the login form renders no such
 * button and imports no provider icon.
 */
export const hasFederatedProvider = false;
