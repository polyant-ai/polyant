// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserRole } from "./users.schema.js";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  name?: string;
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
