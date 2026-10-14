// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { RequirePermission, Permission } from "../../authz/index.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { ManagementApiKeySummary } from "../../auth/management-api-keys.store.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../../management-audit/management-audit-logger.js";
import { ApiKeysService, type ApiKeysCaller } from "./api-keys.service.js";

/**
 * `permissions` is refused rather than ignored: a caller that sends one expects
 * a narrower key, and silently issuing the Owner set instead would hand out more
 * than was asked for.
 */
const CreateApiKeySchema = z
  .object({
    name: z.string().trim().min(1, "is required").max(255),
    expiresAt: z
      .string()
      .max(64)
      .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO date")
      .transform((value) => new Date(value))
      .refine((date) => date.getTime() > Date.now(), "must be in the future")
      .nullish(),
  })
  .strict();

/** The wire shape of a key: ISO timestamps, never the hash or the secret. */
function toResponse(key: ManagementApiKeySummary) {
  return {
    id: key.id,
    name: key.name,
    permissions: key.permissions,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}

/** Only a person reaches a mutation here; the service refuses a key first. */
function auditActor(caller: ApiKeysCaller | undefined) {
  return caller?.principalType === "user" ? toManagementAuditActor(caller) : undefined;
}

/**
 * Management API keys of one organization: the credential `polyant-cli` and any
 * other automation present in `X-Polyant-Key`.
 *
 * Every handler declares `org:write`, held by the Owner role only. The service
 * refuses to issue or revoke for a request authenticated with a key, so a key
 * can neither mint nor revoke keys; it may only list its own organization's.
 * Key administration is rare, so the controller carries the same tight
 * throttle window as membership management.
 */
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller("api/organizations/:orgSlug/api-keys")
export class ApiKeysController {
  constructor(
    @Inject(ApiKeysService)
    private readonly apiKeys: ApiKeysService,
  ) {}

  private readonly auditLogger = createManagementAuditLogger();

  @RequirePermission(Permission.ORG_WRITE)
  @Get()
  async list(
    @Param("orgSlug") orgSlug: string,
    @CurrentUser() caller: ApiKeysCaller | undefined,
  ) {
    const keys = await this.apiKeys.list(orgSlug, caller);
    return { keys: keys.map(toResponse) };
  }

  @RequirePermission(Permission.ORG_WRITE)
  @Post()
  async create(
    @Param("orgSlug") orgSlug: string,
    @Body() body: unknown,
    @CurrentUser() caller: ApiKeysCaller | undefined,
  ) {
    if (body && typeof body === "object" && "permissions" in body) {
      throw new BadRequestException(
        "permissions cannot be chosen: every key carries the Owner permission set",
      );
    }
    const parsed = CreateApiKeySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(", "),
      );
    }

    const { key, token } = await this.apiKeys.create(
      orgSlug,
      { name: parsed.data.name, expiresAt: parsed.data.expiresAt ?? null },
      caller,
    );
    this.auditLogger.log({
      action: ManagementAuditAction.ApiKeyCreate,
      actor: auditActor(caller),
      targetType: ManagementAuditTarget.ApiKey,
      targetId: key.id,
      metadata: { orgSlug, name: key.name, expiresAt: key.expiresAt?.toISOString() ?? null },
    });
    return { key: toResponse(key), token };
  }

  @RequirePermission(Permission.ORG_WRITE)
  @Delete(":keyId")
  async remove(
    @Param("orgSlug") orgSlug: string,
    @Param("keyId") keyId: string,
    @CurrentUser() caller: ApiKeysCaller | undefined,
  ) {
    await this.apiKeys.remove(orgSlug, keyId, caller);
    this.auditLogger.log({
      action: ManagementAuditAction.ApiKeyDelete,
      actor: auditActor(caller),
      targetType: ManagementAuditTarget.ApiKey,
      targetId: keyId,
      metadata: { orgSlug },
    });
    return { deleted: true };
  }
}
