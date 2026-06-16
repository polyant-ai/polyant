// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  Res,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import type { Response } from "express";
import {
  listAllInstances,
  findInstanceBySlug,
  createInstance,
  updateInstance,
  deleteInstance,
  type Instance,
} from "../../instances/store.js";
import { seedInstancePrompts } from "../../instances/prompts.store.js";
import { seedInstanceTools } from "../../instances/instance-tools.store.js";
import { seedInstanceSkills } from "../../instances/instance-skills.store.js";
import { invalidateInstanceConfigCache } from "../../instances/config-resolver.js";
import { invalidateEmbeddingContext } from "../../embeddings-gateway/provider-resolver.js";
import {
  embeddingProviderChanged,
  resetEmbeddingsForProviderSwitch,
  type EmbeddingResetResult,
} from "../../embeddings-gateway/embedding-reset.service.js";
import { countMemories } from "../../memory/index.js";
import { countDocuments } from "../../knowledge/index.js";
import { computeMemoryStatusFromInstance } from "../memories/memory-status.js";
import { providerConfigs, isThinkingCapable } from "../../ai-gateway/config.js";
import { validateIconDataUri } from "../../instances/icon-validator.js";
import { isUniqueViolation } from "../../utils/db-errors.js";
import { channelManager } from "../../channels/channel-manager.js";

/**
 * Explicit response DTO — never return the raw Drizzle entity so schema additions
 * (e.g. internal flags) are not accidentally exposed via the API.
 *
 * Note: `icon` is returned as a URL (not a data URI) to keep list payloads small —
 * the binary is served separately by GET /api/instances/:slug/icon.  A cache-busting
 * `v=<updatedAt>` query param ensures the browser reloads after an icon change.
 */
function toInstanceDto(instance: Instance) {
  return {
    id: instance.id,
    slug: instance.slug,
    name: instance.name,
    description: instance.description,
    status: instance.status,
    provider: instance.provider,
    model: instance.model,
    memoryEnabled: instance.memoryEnabled,
    knowledgeEnabled: instance.knowledgeEnabled,
    langsmithEnabled: instance.langsmithEnabled,
    langsmithProject: instance.langsmithProject,
    authEnabled: instance.authEnabled,
    thinkingEnabled: instance.thinkingEnabled,
    sttProvider: instance.sttProvider,
    embeddingDim: instance.embeddingDim,
    icon: instance.icon
      ? `/api/instances/${instance.slug}/icon?v=${instance.updatedAt?.getTime() ?? 0}`
      : null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

/** Parse a `data:image/<type>;base64,<payload>` URI. Returns null on invalid input. */
function parseDataUri(dataUri: string): { contentType: string; body: Buffer } | null {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(dataUri);
  if (!match) return null;
  try {
    return { contentType: match[1], body: Buffer.from(match[2], "base64") };
  } catch {
    return null;
  }
}

@Controller("api/instances")
export class InstancesController {
  // GET /api/instances — list all instances
  @Get()
  async list() {
    const all = await listAllInstances();
    return { instances: all.map(toInstanceDto) };
  }

  // GET /api/instances/models — list available providers and models
  @Get("models")
  getModels() {
    const providers: Record<string, { models: { id: string; tier: string | null; costInput: number; costOutput: number; supportsThinking: boolean }[] }> = {};
    for (const [name, cfg] of Object.entries(providerConfigs)) {
      const tierByModel = new Map(Object.entries(cfg.tiers).map(([tier, modelId]) => [modelId, tier]));
      const models = Object.entries(cfg.costPerMillionTokens).map(([modelId, cost]) => ({
        id: modelId,
        tier: tierByModel.get(modelId) ?? null,
        costInput: cost.input,
        costOutput: cost.output,
        // Computed server-side from the same single source of truth used by the
        // runtime gate (config-resolver), so the toggle visibility on the
        // frontend cannot drift from the actual capability.
        supportsThinking: isThinkingCapable(name, modelId),
      }));
      providers[name] = { models };
    }
    return { providers };
  }

  // GET /api/instances/:slug — get by slug
  @Get(":slug")
  async getBySlug(@Param("slug") slug: string) {
    this.validateSlug(slug);
    const instance = await findInstanceBySlug(slug);
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    return {
      instance: {
        ...toInstanceDto(instance),
        memory: await computeMemoryStatusFromInstance(instance),
      },
    };
  }

  // GET /api/instances/:slug/icon — serve the icon binary
  // Separated from the JSON DTO so list/detail responses stay small (#85 follow-up).
  @Get(":slug/icon")
  async getIcon(@Param("slug") slug: string, @Res() res: Response): Promise<void> {
    this.validateSlug(slug);
    const instance = await findInstanceBySlug(slug);
    if (!instance || !instance.icon) {
      throw new NotFoundException(`Icon not found for instance "${slug}"`);
    }
    const parsed = parseDataUri(instance.icon);
    if (!parsed) {
      throw new NotFoundException(`Icon for instance "${slug}" is not a valid data URI`);
    }
    res.setHeader("Content-Type", parsed.contentType);
    res.setHeader("Content-Length", parsed.body.length);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(parsed.body);
  }

  // POST /api/instances — create
  @Post()
  async create(@Body() body: { slug: string; name: string; description?: string; provider?: string; model?: string }) {
    this.validateSlug(body.slug);
    this.validateModelConfig(body.provider, body.model);
    // Rely on the DB unique constraint as the authoritative duplicate check.
    // A pre-select + insert would introduce a TOCTOU race window.
    let instance: Instance;
    try {
      instance = await createInstance(body);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Slug "${body.slug}" already exists`);
      }
      throw err;
    }

    // Seed DB stores for the new instance
    await seedInstancePrompts(instance.id);
    await seedInstanceTools(instance.id);
    await seedInstanceSkills(instance.id);

    return { instance: toInstanceDto(instance) };
  }

  // PATCH /api/instances/:slug — update
  @Patch(":slug")
  async update(
    @Param("slug") slug: string,
    @Body() body: {
      name?: string;
      description?: string | null;
      status?: string;
      provider?: string | null;
      model?: string | null;
      memoryEnabled?: boolean;
      knowledgeEnabled?: boolean;
      langsmithEnabled?: boolean;
      langsmithProject?: string | null;
      authEnabled?: boolean;
      thinkingEnabled?: boolean;
      sttProvider?: "openai" | "aws" | "deepgram";
      /**
       * Explicit acknowledgement that changing the embedding provider will
       * permanently delete this instance's memories and knowledge base. Required
       * when the switch would discard existing data — protects scripted callers
       * from accidental data loss. The UI sets it after the user confirms.
       */
      confirmWipe?: boolean;
    },
  ) {
    this.validateSlug(slug);
    this.validateModelConfig(body.provider, body.model);
    // Capture the pre-update state to detect an embedding-relevant provider switch.
    const before = await findInstanceBySlug(slug);
    if (!before) throw new NotFoundException(`Instance "${slug}" not found`);

    // A provider switch that changes the embedding provider abandons the old
    // embedding space (vectors become uninterpretable). We do NOT convert them —
    // existing memories + knowledge are wiped. Require explicit confirmation when
    // there is data to lose, so a Management-API caller can't destroy it silently.
    const afterProvider = body.provider !== undefined ? body.provider : before.provider;
    const willWipe = embeddingProviderChanged(before, { provider: afterProvider });
    if (willWipe && !body.confirmWipe) {
      const hasData =
        (await countMemories(before.id)) > 0 || (await countDocuments(before.id)) > 0;
      if (hasData) {
        throw new BadRequestException(
          "Changing the embedding provider permanently deletes all memories and the entire knowledge base for this instance (existing embeddings cannot be converted). Re-send the request with confirmWipe: true to proceed.",
        );
      }
    }

    let instance = await updateInstance(slug, body);
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    invalidateInstanceConfigCache(slug);
    invalidateEmbeddingContext(instance.id, slug);

    let wiped: EmbeddingResetResult | null = null;
    if (willWipe) {
      wiped = await resetEmbeddingsForProviderSwitch(instance.id, instance.provider);
      // embedding_dim changed — drop the now-stale cached context and refresh the DTO.
      invalidateEmbeddingContext(instance.id, slug);
      instance = (await findInstanceBySlug(slug)) ?? instance;
    }

    return {
      instance: {
        ...toInstanceDto(instance),
        memory: await computeMemoryStatusFromInstance(instance),
      },
      wiped,
    };
  }

  // DELETE /api/instances/:slug — delete
  @Delete(":slug")
  async remove(@Param("slug") slug: string) {
    this.validateSlug(slug);
    // Stop running channel adapters BEFORE the DB row is removed. Otherwise
    // Telegram long-pollers and Slack socket workers keep calling
    // `handleMessage(slug, …)` against a missing instance forever, generating
    // an error loop until the engine restarts.
    try {
      await channelManager.stopAllForInstance(slug);
    } catch (err) {
      // Best-effort: a stuck adapter must not block the delete.
      // Pass the user-controlled slug as a separate argument so it is never
      // treated as part of the format string (CodeQL js/tainted-format-string).
      console.error("[instances] failed to stop channels for instance:", slug, err);
    }
    const deleted = await deleteInstance(slug);
    if (!deleted) throw new NotFoundException(`Instance "${slug}" not found`);
    // DB CASCADE handles cleanup of prompts, tools, skills, etc.
    return { deleted: true };
  }

  // PUT /api/instances/:slug/icon — set icon
  @Put(":slug/icon")
  async setIcon(@Param("slug") slug: string, @Body() body: { icon: string }) {
    this.validateSlug(slug);
    if (!body.icon) throw new BadRequestException("icon is required");
    validateIconDataUri(body.icon);
    const instance = await updateInstance(slug, { icon: body.icon });
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    return { instance: toInstanceDto(instance) };
  }

  // DELETE /api/instances/:slug/icon — remove icon
  @Delete(":slug/icon")
  async removeIcon(@Param("slug") slug: string) {
    this.validateSlug(slug);
    const instance = await updateInstance(slug, { icon: null });
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    return { instance: toInstanceDto(instance) };
  }

  /**
   * Validate slug format and length.  Enforces the DB column limit (varchar(100))
   * so callers get a 400 instead of a 500 on pathologically long inputs.
   */
  private validateSlug(slug: string): void {
    if (typeof slug !== "string" || slug.length === 0 || slug.length > 100) {
      throw new BadRequestException(`Invalid slug: must be 1-100 characters.`);
    }
    if (!/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(slug)) {
      throw new BadRequestException(
        `Invalid slug format. Use lowercase alphanumeric, hyphens, or underscores (e.g. "my-assistant").`,
      );
    }
  }

  /** Validate provider/model values against the configured providerConfigs. */
  private validateModelConfig(provider?: string | null, model?: string | null) {
    const validProviders = Object.keys(providerConfigs);
    if (provider && !validProviders.includes(provider)) {
      throw new BadRequestException(`Invalid provider "${provider}". Valid providers: ${validProviders.join(", ")}`);
    }
    if (model) {
      const effectiveProvider = provider || "openai";
      const cfg = providerConfigs[effectiveProvider];
      const validModels = cfg ? [
        ...Object.values(cfg.tiers),
        ...Object.keys(cfg.costPerMillionTokens),
      ] : [];
      if (!validModels.includes(model)) {
        throw new BadRequestException(`Invalid model "${model}" for provider "${effectiveProvider}". Valid models: ${validModels.join(", ")}`);
      }
    }
  }
}
