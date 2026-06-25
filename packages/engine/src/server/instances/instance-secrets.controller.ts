// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Put, Delete, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { setSecret, listSecretKeys, deleteSecret } from "../../instances/secrets.store.js";
import { invalidateInstanceConfigCache } from "../../instances/config-resolver.js";
import { invalidateEmbeddingContext } from "../../embeddings-gateway/provider-resolver.js";
import { findInstanceOrFail } from "./instance-helpers.js";
import { asAgentSlug } from "../../instances/identifiers.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../../management-audit/management-audit-logger.js";
import { RequirePermission, Permission } from "../../authz/index.js";

const PutSecretsSchema = z.object({
  secrets: z
    .array(
      z.object({
        key: z
          .string()
          .regex(/^[a-z0-9_]+$/, "must match /^[a-z0-9_]+$/")
          .max(64),
        value: z.string().max(8 * 1024),
      }),
    )
    .min(1)
    .max(64),
});

@Controller("api/agents")
export class InstanceSecretsController {
  private readonly auditLogger = createManagementAuditLogger();

  @RequirePermission(Permission.SECRET_READ)
  @Get(":slug/secrets")
  async listSecrets(@Param("slug") slug: string) {
    await findInstanceOrFail(slug);
    const secrets = await listSecretKeys(asAgentSlug(slug));
    return { secrets };
  }

  @RequirePermission(Permission.SECRET_WRITE)
  @Put(":slug/secrets")
  async setSecrets(
    @Param("slug") slug: string,
    @Body() body: unknown,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const parsed = PutSecretsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
    }

    const instance = await findInstanceOrFail(slug);
    const actor = toManagementAuditActor(user);

    for (const entry of parsed.data.secrets) {
      if (!entry.value) continue;
      await setSecret(instance.id, entry.key, entry.value);
      // Audit the key only — the secret value is never recorded.
      this.auditLogger.log({
        action: ManagementAuditAction.SecretWrite,
        actor,
        targetType: ManagementAuditTarget.Secret,
        targetId: entry.key,
        metadata: { agentSlug: slug },
      });
    }

    invalidateInstanceConfigCache(asAgentSlug(slug));
    // Embedding context (provider credentials, e.g. aws_region / openai_api_key)
    // is cached separately; invalidate it too or embeds can fail for up to 30s.
    invalidateEmbeddingContext(instance.id, slug);
    const secrets = await listSecretKeys(asAgentSlug(slug));
    return { secrets };
  }

  @RequirePermission(Permission.SECRET_WRITE)
  @Delete(":slug/secrets/:key")
  async removeSecret(
    @Param("slug") slug: string,
    @Param("key") key: string,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const instance = await findInstanceOrFail(slug);
    await deleteSecret(instance.id, key);
    this.auditLogger.log({
      action: ManagementAuditAction.SecretDelete,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Secret,
      targetId: key,
      metadata: { agentSlug: slug },
    });
    invalidateInstanceConfigCache(asAgentSlug(slug));
    invalidateEmbeddingContext(instance.id, slug);
    return { deleted: true };
  }
}
