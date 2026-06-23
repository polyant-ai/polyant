// SPDX-License-Identifier: AGPL-3.0-or-later

import { Module, type OnModuleInit } from "@nestjs/common";
import { bootstrapOrganizations } from "./bootstrap.js";

/**
 * Owns the first-boot RBAC bootstrap (design §8). The migration (0051) creates
 * and seeds the tenancy tables; this module's `onModuleInit` runs the
 * idempotent runtime bootstrap (Platform Superadmin promotion, fresh-install
 * no-op) once the NestJS app initializes.
 */
@Module({})
export class OrganizationsModule implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    try {
      await bootstrapOrganizations();
    } catch (err) {
      // Never block boot — mirror the existing superadmin seed behaviour.
      console.error("[organizations] Bootstrap failed:", err);
    }
  }
}
