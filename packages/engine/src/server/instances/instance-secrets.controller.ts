// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Get, Put, Delete, Param, Body, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { setSecret, listSecretKeys, deleteSecret } from "../../instances/secrets.store.js";
import { invalidateInstanceConfigCache } from "../../instances/config-resolver.js";
import { invalidateEmbeddingContext } from "../../embeddings-gateway/provider-resolver.js";
import { findInstanceOrFail } from "./instance-helpers.js";

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

@Controller("api/instances")
export class InstanceSecretsController {
  @Get(":slug/secrets")
  async listSecrets(@Param("slug") slug: string) {
    await findInstanceOrFail(slug);
    const secrets = await listSecretKeys(slug);
    return { secrets };
  }

  @Put(":slug/secrets")
  async setSecrets(
    @Param("slug") slug: string,
    @Body() body: unknown,
  ) {
    const parsed = PutSecretsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
    }

    const instance = await findInstanceOrFail(slug);

    for (const entry of parsed.data.secrets) {
      if (!entry.value) continue;
      await setSecret(instance.id, entry.key, entry.value);
    }

    invalidateInstanceConfigCache(slug);
    // Embedding context (provider credentials, e.g. aws_region / openai_api_key)
    // is cached separately; invalidate it too or embeds can fail for up to 30s.
    invalidateEmbeddingContext(instance.id, slug);
    const secrets = await listSecretKeys(slug);
    return { secrets };
  }

  @Delete(":slug/secrets/:key")
  async removeSecret(
    @Param("slug") slug: string,
    @Param("key") key: string,
  ) {
    const instance = await findInstanceOrFail(slug);
    await deleteSecret(instance.id, key);
    invalidateInstanceConfigCache(slug);
    invalidateEmbeddingContext(instance.id, slug);
    return { deleted: true };
  }
}
