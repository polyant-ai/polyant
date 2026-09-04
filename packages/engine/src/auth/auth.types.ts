// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PermissionKey } from "../authz/permissions.js";

/**
 * Machine principal behind a request authenticated with a management API key
 * (`X-Polyant-Key`). Org-scoped and carries an explicit permission set, so the
 * PermissionGuard allows a request only when its required permission is a
 * member of `permissions`. Distinct from the per-instance API-key principal
 * (`{ kind: "instance" }`) the PermissionGuard already handles.
 */
export interface ServicePrincipal {
  principalType: "service";
  orgId: string;
  permissions: ReadonlySet<PermissionKey>;
}

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
  // In session mode (Auth.js) the engine owns the user record and `mustChangePassword`
  // is always populated. In gateway-authenticated modes (`alb-oidc`, future GCP IAP, …) the
  // engine has no local user row — identity is forwarded by the gateway. Platform-admin
  // standing is never carried here (see the note above `principalType`): it is resolved
  // from `users.is_platform_admin` per request by whatever checks `@PlatformAdminOnly()`.
  mustChangePassword?: boolean;
  groups?: string[];
  source?: "session" | "alb-oidc";
}
