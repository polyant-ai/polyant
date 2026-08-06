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
import { RequirePermission, Permission } from "../../authz/index.js";
import {
  listAllInstances,
  findInstanceBySlug,
  createInstance,
  updateInstance,
  deleteInstance,
  resolvePrincipalOrgId,
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
import { computeMemoryStatusFromInstance, computeEmbedderStatus } from "../memories/memory-status.js";
import { providerConfigs, isThinkingCapable, isReasoningAlwaysOn, clampTemperature, temperatureSupported, cacheSupported, reasoningLevelsFor } from "../../ai-gateway/config.js";
import type { ReasoningLevel } from "../../ai-gateway/model-catalog.js";
import { validateIconDataUri } from "../../instances/icon-validator.js";
import { buildInstanceIconUrl } from "../../instances/icon-url.js";
import { isUniqueViolation } from "../../utils/db-errors.js";
import { channelManager } from "../../channels/channel-manager.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { sanitizeForLog } from "../../utils/create-logger.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import { WorkspaceSlug } from "../../auth/decorators/workspace-slug.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../../management-audit/management-audit-logger.js";

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
    thinkingLevel: instance.thinkingLevel,
    temperature: instance.temperature,
    stateInPromptEnabled: instance.stateInPromptEnabled,
    datetimeInjectionEnabled: instance.datetimeInjectionEnabled,
    cacheEnabled: instance.cacheEnabled,
    cacheTtl: instance.cacheTtl,
    toolResultsInHistoryEnabled: instance.toolResultsInHistoryEnabled,
    debugEnabled: instance.debugEnabled,
    optoutEnabled: instance.optoutEnabled,
    optoutStopKeywords: instance.optoutStopKeywords,
    optoutResumeKeywords: instance.optoutResumeKeywords,
    optoutClosingMessage: instance.optoutClosingMessage,
    optoutResumeMessage: instance.optoutResumeMessage,
    optoutInjectPromptHint: instance.optoutInjectPromptHint,
    sttProvider: instance.sttProvider,
    embeddingDim: instance.embeddingDim,
    embeddingProvider: instance.embeddingProvider,
    icon: buildInstanceIconUrl(instance.slug, instance.icon, instance.updatedAt),
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
  private readonly auditLogger = createManagementAuditLogger();

  // GET /api/instances — list the caller organization's instances
  @RequirePermission(Permission.AGENT_READ)
  @Get()
  async list(
    @CurrentUser() user?: AuthenticatedUser,
    @WorkspaceSlug() workspaceSlug?: string,
  ) {
    // Agents are org-owned, and this route carries no `:slug` for the guard to
    // scope on — so the org filter is applied here. An unresolvable organization
    // yields an empty list (fail closed), never the whole deployment.
    const orgId = await resolvePrincipalOrgId(user?.orgId);
    if (!orgId) return { instances: [] };
    // Narrowed to the addressed workspace when the caller is inside one. Without
    // this, `/workspaces/sandbox/instances` listed every agent in the ORG,
    // including other workspaces' — so the page advertised an isolation that did
    // not exist. Still org-filtered underneath: the workspace narrows, it never
    // widens, and a foreign slug matches nothing.
    const all = await listAllInstances(orgId, workspaceSlug);
    return { instances: all.map(toInstanceDto) };
  }

  // GET /api/instances/models — list available providers and models
  @RequirePermission(Permission.AGENT_READ)
  @Get("models")
  getModels() {
    const providers: Record<string, { models: { id: string; tier: string | null; costInput: number; costOutput: number; costCacheRead: number; costCacheWrite: number; supportsCache: boolean; supportsThinking: boolean; reasoningAlwaysOn: boolean; reasoningLevels: readonly ReasoningLevel[]; supportsTemperature: boolean; supportsTemperatureWithThinking: boolean }[] }> = {};
    for (const [name, cfg] of Object.entries(providerConfigs)) {
      const tierByModel = new Map(Object.entries(cfg.tiers).map(([tier, modelId]) => [modelId, tier]));
      const models = Object.entries(cfg.models).map(([modelId, cost]) => ({
        id: modelId,
        tier: tierByModel.get(modelId) ?? null,
        costInput: cost.input,
        costOutput: cost.output,
        // Absolute per-1M cache rates straight from the catalog; fall back to the
        // input rate when the model has no cache discount (Nebius / non-anthropic-nova
        // Bedrock report cached tokens but bill them full). costCacheWrite === 0 =
        // caches with no write premium (OpenAI pre-5.6).
        costCacheRead: cost.cacheRead ?? cost.input,
        costCacheWrite: cost.cacheWrite ?? cost.input,
        // Whether the provider+model has real prompt caching — a UI hint; single
        // source of truth shared with the runtime marker gate (bedrock.ts).
        supportsCache: cacheSupported(name, modelId),
        // Computed server-side from the same source used by the runtime gate
        // (config-resolver), so frontend toggle visibility can't drift.
        supportsThinking: isThinkingCapable(name, modelId),
        // gpt-oss & co. reason on every call (no off) — the UI locks the toggle
        // ON and shows a hint rather than pretending it can be disabled.
        reasoningAlwaysOn: isReasoningAlwaysOn(modelId),
        // The effort levels this model accepts (live-verified). The FE renders the
        // level picker from this exact set — empty for non-reasoning models.
        reasoningLevels: reasoningLevelsFor(name, modelId),
        supportsTemperature: temperatureSupported(name, modelId, false),
        // Whether a custom temperature survives WITH thinking on. True for open-weight/
        // vLLM reasoners (gpt-oss, Bedrock MiniMax, all Nebius reasoners); false for the
        // strict-reasoning APIs (Anthropic extended thinking, OpenAI 1P). Lets the FE
        // keep the temperature field editable under thinking where the model allows it.
        supportsTemperatureWithThinking: temperatureSupported(name, modelId, true),
      }));
      providers[name] = { models };
    }
    return { providers };
  }

  // GET /api/instances/:slug — get by slug
  @RequirePermission(Permission.AGENT_READ)
  @Get(":slug")
  async getBySlug(@Param("slug") slug: string) {
    this.validateSlug(slug);
    const instance = await findInstanceBySlug(asInstanceSlug(slug));
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    return {
      instance: {
        ...toInstanceDto(instance),
        memory: await computeMemoryStatusFromInstance(instance),
        embedder: await computeEmbedderStatus(instance),
      },
    };
  }

  // GET /api/instances/:slug/icon — serve the icon binary
  // Separated from the JSON DTO so list/detail responses stay small (#85 follow-up).
  @RequirePermission(Permission.AGENT_READ)
  @Get(":slug/icon")
  async getIcon(@Param("slug") slug: string, @Res() res: Response): Promise<void> {
    this.validateSlug(slug);
    const instance = await findInstanceBySlug(asInstanceSlug(slug));
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
  @RequirePermission(Permission.AGENT_WRITE)
  @Post()
  async create(
    @Body() body: { slug: string; name: string; description?: string; provider?: string; model?: string },
    @CurrentUser() user?: AuthenticatedUser,
    @WorkspaceSlug() workspaceSlug?: string,
  ) {
    this.validateSlug(body.slug);
    this.validateModelConfig(body.provider, body.model);
    // Resolve the owning organization up front: the store fails closed on an
    // unresolvable one, and that is a caller-side condition (a principal with no
    // org claim on a multi-org deployment), not a server fault — surface it as a
    // 400 rather than letting the throw escape as a 500.
    const orgId = await resolvePrincipalOrgId(user?.orgId);
    if (!orgId) {
      throw new BadRequestException(
        "Cannot resolve the caller's organization — the agent has no workspace to be created in.",
      );
    }
    // Rely on the DB unique constraint as the authoritative duplicate check.
    // A pre-select + insert would introduce a TOCTOU race window.
    let instance: Instance;
    try {
      // `orgId` last: it comes from the authenticated principal and must never be
      // overridable by a field of the request body. `workspaceSlug` comes from a
      // header, not the body, for the same reason — and it is validated against
      // `orgId` inside the store before it decides anything.
      instance = await createInstance({
        ...body,
        slug: asInstanceSlug(body.slug),
        orgId,
        workspaceSlug,
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`Slug "${body.slug}" already exists`);
      }
      // An addressed workspace that is not the caller's own is a caller-side
      // condition, not a server fault: the agent is deliberately NOT filed under
      // the organization default, because creating it somewhere other than the
      // address bar says is the bug this path exists to prevent.
      if (err instanceof Error && err.message.includes("does not belong to the caller")) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    // Seed DB stores for the new instance
    await seedInstancePrompts(instance.id);
    await seedInstanceTools(instance.id);
    await seedInstanceSkills(instance.id);

    this.auditLogger.log({
      action: ManagementAuditAction.AgentCreate,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Agent,
      targetId: instance.slug,
    });

    return { instance: toInstanceDto(instance) };
  }

  // PATCH /api/instances/:slug — update
  @RequirePermission(Permission.AGENT_WRITE)
  @Patch(":slug")
  async update(
    @Param("slug") slug: string,
    @Body() body: {
      name?: string;
      description?: string | null;
      status?: string;
      provider?: string | null;
      model?: string | null;
      /** Embedder provider (openai|bedrock), independent of the chat provider. Changing it wipes data. */
      embeddingProvider?: "openai" | "bedrock";
      memoryEnabled?: boolean;
      knowledgeEnabled?: boolean;
      langsmithEnabled?: boolean;
      langsmithProject?: string | null;
      authEnabled?: boolean;
      thinkingEnabled?: boolean;
      thinkingLevel?: string;
      temperature?: number | null;
      stateInPromptEnabled?: boolean;
      datetimeInjectionEnabled?: boolean;
      cacheEnabled?: boolean;
      cacheTtl?: string;
      toolResultsInHistoryEnabled?: boolean;
      debugEnabled?: boolean;
      sttProvider?: "openai" | "aws" | "deepgram";
      optoutEnabled?: boolean;
      optoutStopKeywords?: string[];
      optoutResumeKeywords?: string[];
      optoutClosingMessage?: string | null;
      optoutResumeMessage?: string | null;
      optoutInjectPromptHint?: boolean;
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
    this.validateEmbeddingProvider(body.embeddingProvider);
    body.optoutStopKeywords = this.normalizeKeywords(body.optoutStopKeywords, "optoutStopKeywords");
    body.optoutResumeKeywords = this.normalizeKeywords(body.optoutResumeKeywords, "optoutResumeKeywords");
    if (body.temperature !== undefined) {
      body.temperature = clampTemperature(body.temperature);
    }
    // Accept the full effort union; the ai-gateway clamps to the chosen model's
    // catalog reasoningLevels at call time (so xhigh/max never reach a model that
    // rejects them), and the FE only offers the model's actual subset.
    if (body.thinkingLevel !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(body.thinkingLevel)) {
      throw new BadRequestException('thinkingLevel must be one of "low", "medium", "high", "xhigh", "max"');
    }
    // Capture the pre-update state to detect an embedding-provider switch.
    const before = await findInstanceBySlug(asInstanceSlug(slug));
    if (!before) throw new NotFoundException(`Instance "${slug}" not found`);

    // Changing the embedding provider abandons the old embedding space (vectors
    // become uninterpretable) — existing memories + knowledge are wiped, never
    // converted. Changing only the chat provider/model does NOT trigger this.
    // Require explicit confirmation when there is data to lose, so a Management-API
    // caller can't destroy it silently.
    const afterEmbeddingProvider =
      body.embeddingProvider !== undefined ? body.embeddingProvider : before.embeddingProvider;
    const willWipe = embeddingProviderChanged(
      { embeddingProvider: before.embeddingProvider },
      { embeddingProvider: afterEmbeddingProvider },
    );
    if (willWipe && !body.confirmWipe) {
      const hasData =
        (await countMemories(before.slug)) > 0 || (await countDocuments(before.slug)) > 0;
      if (hasData) {
        throw new BadRequestException(
          "Changing the embedding provider permanently deletes all memories and the entire knowledge base for this instance (existing embeddings cannot be converted). Re-send the request with confirmWipe: true to proceed.",
        );
      }
    }

    let instance = await updateInstance(asInstanceSlug(slug), body);
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    invalidateInstanceConfigCache(asInstanceSlug(slug));
    invalidateEmbeddingContext(instance.id, slug);

    let wiped: EmbeddingResetResult | null = null;
    if (willWipe) {
      wiped = await resetEmbeddingsForProviderSwitch(before.slug, instance.id, instance.embeddingProvider);
      // embedding_dim changed — drop the now-stale cached context and refresh the DTO.
      invalidateEmbeddingContext(instance.id, slug);
      instance = (await findInstanceBySlug(asInstanceSlug(slug))) ?? instance;
    }

    return {
      instance: {
        ...toInstanceDto(instance),
        memory: await computeMemoryStatusFromInstance(instance),
        embedder: await computeEmbedderStatus(instance),
      },
      wiped,
    };
  }

  // DELETE /api/instances/:slug — delete
  @RequirePermission(Permission.AGENT_DELETE)
  @Delete(":slug")
  async remove(@Param("slug") slug: string, @CurrentUser() user?: AuthenticatedUser) {
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
      console.error("[instances] failed to stop channels for instance:", sanitizeForLog(slug), err);
    }
    const deleted = await deleteInstance(asInstanceSlug(slug));
    if (!deleted) throw new NotFoundException(`Instance "${slug}" not found`);
    this.auditLogger.log({
      action: ManagementAuditAction.AgentDelete,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Agent,
      targetId: slug,
    });
    // deleteInstance() runs in a transaction: it explicitly removes operational
    // data keyed by slug (conversations, messages, memories, knowledge base,
    // scheduled tasks); the DB CASCADE removes config (prompts, tools, skills,
    // channels, secrets, room, webhooks); audit/telemetry is preserved on purpose.
    return { deleted: true };
  }

  // PUT /api/instances/:slug/icon — set icon
  @RequirePermission(Permission.AGENT_WRITE)
  @Put(":slug/icon")
  async setIcon(@Param("slug") slug: string, @Body() body: { icon: string }) {
    this.validateSlug(slug);
    if (!body.icon) throw new BadRequestException("icon is required");
    validateIconDataUri(body.icon);
    const instance = await updateInstance(asInstanceSlug(slug), { icon: body.icon });
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);
    return { instance: toInstanceDto(instance) };
  }

  // DELETE /api/instances/:slug/icon — remove icon
  @RequirePermission(Permission.AGENT_WRITE)
  @Delete(":slug/icon")
  async removeIcon(@Param("slug") slug: string) {
    this.validateSlug(slug);
    const instance = await updateInstance(asInstanceSlug(slug), { icon: null });
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

  /** Validate + normalize a keyword list: non-empty trimmed strings, deduped (case-insensitive). */
  private normalizeKeywords(keywords: string[] | undefined, field: string): string[] | undefined {
    if (keywords === undefined) return undefined;
    if (!Array.isArray(keywords)) throw new BadRequestException(`${field} must be an array of strings`);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of keywords) {
      if (typeof raw !== "string") throw new BadRequestException(`${field} must contain only strings`);
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(trimmed);
    }
    if (out.length === 0) throw new BadRequestException(`${field} must contain at least one non-empty keyword`);
    return out;
  }

  /** Validate the embedder provider. Only OpenAI and Bedrock embed (Anthropic has no embeddings API). */
  private validateEmbeddingProvider(embeddingProvider?: string) {
    if (embeddingProvider !== undefined && embeddingProvider !== "openai" && embeddingProvider !== "bedrock") {
      throw new BadRequestException(
        `Invalid embeddingProvider "${embeddingProvider}". Valid embedding providers: openai, bedrock.`,
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
        ...Object.keys(cfg.models),
      ] : [];
      if (!validModels.includes(model)) {
        throw new BadRequestException(`Invalid model "${model}" for provider "${effectiveProvider}". Valid models: ${validModels.join(", ")}`);
      }
    }
  }
}
