// SPDX-License-Identifier: AGPL-3.0-or-later

import { SetMetadata } from "@nestjs/common";
import type { FeatureKey } from "../entitlement.service.js";

export const REQUIRES_FEATURE_KEY = "authz:requires_feature";

/**
 * Gate a route behind an Enterprise license feature. The PermissionGuard checks
 * `EntitlementService.isAvailable(feature)` and denies (404-equivalent 403) when
 * the feature is not licensed. In OSS builds every feature is unavailable, so
 * any `@RequiresFeature()` route is unreachable — enforced even in shadow mode
 * because an absent feature is a hard capability gap, not a permission opinion.
 */
export const RequiresFeature = (feature: FeatureKey) =>
  SetMetadata(REQUIRES_FEATURE_KEY, feature);
