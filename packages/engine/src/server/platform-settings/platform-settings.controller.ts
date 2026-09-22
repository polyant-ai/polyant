// SPDX-License-Identifier: AGPL-3.0-or-later

import { BadRequestException, Body, Controller, Get, Patch } from "@nestjs/common";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import { PlatformAdminOnly } from "../../authz/index.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../../management-audit/management-audit-logger.js";
import {
  getStoredPlatformSettings,
  resolvePlatformSettings,
  updatePlatformSettings,
  PLATFORM_SETTING_NUMBERS,
  type PlatformSettingNumber,
  type StoredPlatformSettings,
} from "../../platform/platform-settings.store.js";

/**
 * An ORIGIN, and nothing else: everything built from `baseUrl` appends its own
 * path, so a trailing slash yields `//webhooks` and a path segment yields a
 * redirect URI no provider will match. An empty string is read as "clear it",
 * because that is what an emptied field in the panel means.
 */
function normalizeBaseUrl(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException("baseUrl must be an absolute http(s) URL, or null to clear it");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestException("baseUrl must be an absolute http(s) URL, or null to clear it");
  }
  if (parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new BadRequestException("baseUrl must be an origin, with no path, query or fragment");
  }
  return parsed.origin;
}

/**
 * The installation's own policies, which had no surface because they had no
 * tier: they were `ANALYTICS_RETENTION_DAYS` and `SSE_MAX_CONNECTIONS_PER_USER`,
 * and changing either meant a redeploy.
 *
 * `@PlatformAdminOnly()` rather than a grantable permission, for the reason the
 * two-factor mandate records: these are properties of the whole deployment, and
 * a permission that let one organization's admin shorten the retention window
 * would let them delete another organization's history.
 */
@Controller("api/platform/settings")
@PlatformAdminOnly()
export class PlatformSettingsController {
  private readonly auditLogger = createManagementAuditLogger();

  /**
   * Both shapes, deliberately: `settings` is what is STORED (null = unset) so
   * the form can show an empty field as empty, and `effective` is what is in
   * FORCE so the same form can show what an empty field will actually do.
   * Collapsing them would make "unset" and "set to the default" look identical.
   */
  @Get()
  async read() {
    const [settings, effective] = await Promise.all([
      getStoredPlatformSettings(),
      resolvePlatformSettings(),
    ]);
    return { settings, effective };
  }

  @Patch()
  async update(
    @Body()
    body: (Partial<Record<PlatformSettingNumber, number | null>> & { baseUrl?: string | null }) | undefined,
    @CurrentUser() actor?: AuthenticatedUser,
  ) {
    // `@Body()` is UNDEFINED, not `{}`, for a request that sends no body and no
    // `content-type` — an Express 5 change. Indexing it then threw a TypeError
    // and answered 500 where the route's own next line answers 400.
    const fields = body ?? {};
    const patch: { -readonly [K in keyof StoredPlatformSettings]?: StoredPlatformSettings[K] } = {};
    for (const field of PLATFORM_SETTING_NUMBERS) {
      const value = fields[field];
      if (value === undefined) continue;
      // `null` CLEARS the policy back to the shipped default, which is why these
      // are nullable and not merely optional: omitting a field leaves it alone,
      // and sending null is a decision.
      if (value !== null && (!Number.isInteger(value) || value <= 0)) {
        throw new BadRequestException(`${field} must be a positive integer, or null to clear it`);
      }
      patch[field] = value;
    }
    if (fields.baseUrl !== undefined) {
      patch.baseUrl = normalizeBaseUrl(fields.baseUrl);
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException("No settings to update");
    }

    const settings = await updatePlatformSettings(patch, actor?.userId);
    // Audited BEFORE the value is read back anywhere else: shortening the
    // retention window deletes history on the next housekeeping run, and this
    // row is the only durable record of who asked for it.
    this.auditLogger.log({
      action: ManagementAuditAction.PlatformSettingsUpdate,
      actor: toManagementAuditActor(actor),
      targetType: ManagementAuditTarget.PlatformSettings,
      targetId: "platform",
      metadata: { changed: patch },
    });
    return { settings, effective: await resolvePlatformSettings() };
  }
}
