// SPDX-License-Identifier: AGPL-3.0-or-later

import { Controller, Post, Param, HttpCode, HttpStatus, NotFoundException } from "@nestjs/common";
import { reEmbedInstance } from "../../embeddings-gateway/re-embed.service.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";

/**
 * Triggers a background re-embedding job migrating an instance's legacy 1536-dim
 * memories to the 1024-dim column. Returns 202 immediately — progress is visible
 * via logs and the instance's `embeddingDim` flag.
 */
@Controller("api/instances")
export class ReEmbedController {
  @Post(":slug/memories/re-embed")
  @HttpCode(HttpStatus.ACCEPTED)
  async reEmbed(@Param("slug") slug: string): Promise<{ accepted: true; slug: string }> {
    const instanceId = await resolveInstanceId(slug);
    if (!instanceId) {
      throw new NotFoundException(`Instance "${slug}" not found`);
    }
    setImmediate(() => {
      reEmbedInstance(instanceId).catch((err) => {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error(`[re-embed] background job failed for ${slug}: ${message}`);
      });
    });
    return { accepted: true, slug };
  }
}
