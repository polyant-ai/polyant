// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserRole } from "./users.schema.js";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  name?: string;
  // Discriminates the kind of principal behind the request. Today every
  // authenticated identity is a human end-user; the field is typed now so a
  // future machine principal (service account / API key) can be added without
  // touching every consumer. NOTE: `isPlatformAdmin` is intentionally NOT part
  // of the identity — platform-admin status is resolved from the DB on each
  // privileged check so it stays revocable, instead of being frozen in the JWT.
  principalType: "user";
  // The resolved organization the request acts within. Injected into the JWT at
  // sign-in (web `jwt()` callback) and read back here. Optional because legacy
  // tokens issued before this claim existed (and gateway-forwarded identities)
  // carry no `orgId` until they are re-minted.
  orgId?: string;
  // In session mode (Auth.js) the engine owns the user record and `role` / `mustChangePassword`
  // are always populated. In gateway-authenticated modes (`alb-oidc`, future GCP IAP, …) the
  // engine has no local user row — identity is forwarded by the gateway and there is no local
  // notion of role yet. A Cognito-groups → UserRole mapping is a future follow-up; until then
  // RoleGuard will 403 gateway-mode users on any `@RequireRole()` endpoint.
  role?: UserRole;
  mustChangePassword?: boolean;
  groups?: string[];
  source?: "session" | "alb-oidc";
}
