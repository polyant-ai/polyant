// SPDX-License-Identifier: AGPL-3.0-or-later

import { Injectable } from "@nestjs/common";

/**
 * A licensable feature flag. Kept as a plain string (not a closed enum) so the
 * EE build can introduce new feature keys without editing the OSS contract.
 */
export type FeatureKey = string;

/**
 * Decides whether a licensed feature is available in the running build. The
 * `@RequiresFeature()` decorator + PermissionGuard consult this to gate
 * Enterprise-only routes. The OSS implementation answers "no" to everything;
 * the EE build swaps in an implementation that checks the active license.
 */
export interface EntitlementService {
  isAvailable(feature: FeatureKey): boolean;
}

/** Injection token for the active EntitlementService implementation. */
export const ENTITLEMENT_SERVICE = Symbol("ENTITLEMENT_SERVICE");

/**
 * Open-source entitlement service: no Enterprise feature is ever available.
 * `@RequiresFeature()` routes therefore fail closed in OSS builds.
 */
@Injectable()
export class OssEntitlementService implements EntitlementService {
  isAvailable(_feature: FeatureKey): boolean {
    return false;
  }
}
