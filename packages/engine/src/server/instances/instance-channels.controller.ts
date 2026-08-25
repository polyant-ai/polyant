// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Header,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ZodError } from "zod";
import {
  setChannelConfig, listChannelConfigs, getChannelConfig, deleteChannelConfig,
  CHANNEL_TYPES, CHANNEL_CONFIG_KEYS, resolveWhatsAppAuthMode,
  type ChannelConfig, type ChannelType, type SetChannelConfigResult,
} from "../../instances/channels.store.js";
import { channelManager } from "../../channels/channel-manager.js";
import { syncAgentTool } from "../../instances/agent-tool-sync.js";
import { findInstanceOrFail, maskSensitiveConfig } from "./instance-helpers.js";
import { asInstanceSlug, type InstanceUuid } from "../../instances/identifiers.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import { generateToken } from "../../crypto/index.js";
import { buildTwilioWhatsAppWebhookUrl } from "../webhook-url.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../../management-audit/management-audit-logger.js";

/** Thrown by `getChannelConfig`/`whatsappWebhookUrl` call sites below. */
const WHATSAPP_NOT_IN_API_KEY_MODE = "WhatsApp channel is not configured in API Key mode";

/** A Zod parse failure, or the legacy string-matched validation error shape. */
function isChannelConfigValidationError(err: unknown): err is Error {
  return err instanceof ZodError || (err instanceof Error && err.message.includes("Validation"));
}

@Controller("api/instances")
export class InstanceChannelsController {
  private readonly auditLogger = createManagementAuditLogger();

  @RequirePermission(Permission.CHANNEL_READ)
  @Get(":slug/channels")
  async listChannels(@Param("slug") slug: string) {
    await findInstanceOrFail(slug);
    const channels = await listChannelConfigs(asInstanceSlug(slug));
    const masked = channels.map((ch) => ({
      channelType: ch.channelType,
      enabled: ch.enabled,
      config: maskSensitiveConfig(ch.config),
    }));
    return { channels: masked };
  }

  /**
   * The inbound URL to paste into the Twilio Console. Gated on CHANNEL_WRITE,
   * not CHANNEL_READ: the secret it embeds is bearer-equivalent, so a
   * read-only role must not be able to take over an agent's inbound channel.
   * `no-store` because the response carries that bearer-equivalent secret.
   */
  @RequirePermission(Permission.CHANNEL_WRITE)
  @Header("Cache-Control", "no-store")
  @Get(":slug/channels/whatsapp/webhook-url")
  async whatsappWebhookUrl(@Param("slug") slug: string) {
    await findInstanceOrFail(slug);
    const channel = await getChannelConfig(asInstanceSlug(slug), "whatsapp");
    const secret = channel && resolveWhatsAppAuthMode(channel.config) === "apiKey"
      ? channel.config.webhookSecret
      : undefined;
    if (typeof secret !== "string" || !secret) {
      throw new NotFoundException(WHATSAPP_NOT_IN_API_KEY_MODE);
    }
    return { webhookUrl: buildTwilioWhatsAppWebhookUrl(slug, secret) };
  }

  /** Rotate the inbound secret. The previous URL stops working immediately. */
  @RequirePermission(Permission.CHANNEL_WRITE)
  @Post(":slug/channels/whatsapp/rotate-webhook-secret")
  async rotateWhatsappWebhookSecret(
    @Param("slug") slug: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const instance = await findInstanceOrFail(slug);
    const channel = await getChannelConfig(asInstanceSlug(slug), "whatsapp");
    if (!channel || resolveWhatsAppAuthMode(channel.config) !== "apiKey") {
      throw new NotFoundException(WHATSAPP_NOT_IN_API_KEY_MODE);
    }

    const webhookSecret = generateToken(32);
    const nextConfig = { ...channel.config, webhookSecret };
    await this.saveChannelConfig(instance.id, "whatsapp", nextConfig, channel.enabled);
    if (channel.enabled) {
      await channelManager.startChannel(slug, "whatsapp", nextConfig);
    }

    this.auditWebhookSecretWrite(slug, user);
    return { webhookUrl: buildTwilioWhatsAppWebhookUrl(slug, webhookSecret) };
  }

  /**
   * Merge the request body into the existing config, walking the ALLOWLIST
   * rather than the request body: no property name written into a stored
   * config may come from remote input. Masked values (••••) are skipped so
   * unchanged secrets survive.
   */
  private mergeAllowedConfig(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>,
    channelType: ChannelType,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...existing };
    for (const key of CHANNEL_CONFIG_KEYS[channelType]) {
      if (!(key in incoming)) continue;
      const value = incoming[key];
      if (typeof value === "string" && value.startsWith("••••")) continue;
      merged[key] = value;
    }
    return merged;
  }

  /** Persist the config, translating a schema violation into a 400 instead of a 500. */
  private async saveChannelConfig(
    instanceId: InstanceUuid,
    channelType: ChannelType,
    config: Record<string, unknown>,
    enabled: boolean,
  ): Promise<SetChannelConfigResult> {
    try {
      return await setChannelConfig(instanceId, channelType, config, enabled);
    } catch (err) {
      if (isChannelConfigValidationError(err)) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** Audit a fresh inbound secret — minted on save or explicitly rotated. */
  private auditWebhookSecretWrite(slug: string, user: AuthenticatedUser | undefined): void {
    this.auditLogger.log({
      action: ManagementAuditAction.SecretWrite,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Secret,
      // Key only — the value is never audited.
      targetId: `${slug}:whatsapp.webhookSecret`,
    });
  }

  /** The full webhook URL when the saved channel ended up in apiKey mode, else undefined. */
  private buildWebhookUrlIfApiKeyMode(
    slug: string,
    channelType: ChannelType,
    config: Record<string, unknown>,
  ): string | undefined {
    if (channelType !== "whatsapp" || resolveWhatsAppAuthMode(config) !== "apiKey") return undefined;
    const secret = config.webhookSecret;
    return typeof secret === "string" && secret ? buildTwilioWhatsAppWebhookUrl(slug, secret) : undefined;
  }

  /** Start/stop the channel adapter and mirror the virtual `agent` channel into the tools catalog. */
  private async syncChannelSideEffects(
    slug: string,
    channelType: ChannelType,
    enabled: boolean,
    config: Record<string, unknown>,
    instanceDescription: string | null,
  ): Promise<void> {
    if (enabled) {
      await channelManager.startChannel(slug, channelType, config);
    } else {
      await channelManager.stopChannel(slug, channelType);
    }
    if (channelType === "agent") {
      await syncAgentTool({ slug, description: instanceDescription, enable: enabled });
    }
  }

  /** Build the masked channel + optional webhookUrl response shape shared by `setChannel`. */
  private buildChannelResponse(
    slug: string,
    channelType: ChannelType,
    channel: ChannelConfig | null,
    finalConfig: Record<string, unknown>,
  ) {
    const webhookUrl = this.buildWebhookUrlIfApiKeyMode(slug, channelType, finalConfig);
    return {
      channel: channel ? {
        channelType: channel.channelType,
        enabled: channel.enabled,
        config: maskSensitiveConfig(channel.config),
      } : null,
      ...(webhookUrl ? { webhookUrl } : {}),
    };
  }

  @RequirePermission(Permission.CHANNEL_WRITE)
  @Put(":slug/channels/:type")
  async setChannel(
    @Param("slug") slug: string,
    @Param("type") channelType: string,
    @Body() body: { config: Record<string, unknown>; enabled: boolean },
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    if (!CHANNEL_TYPES.includes(channelType as ChannelType)) {
      throw new BadRequestException(`Invalid channel type "${channelType}". Valid: ${CHANNEL_TYPES.join(", ")}`);
    }
    const type = channelType as ChannelType;
    const instance = await findInstanceOrFail(slug);

    const existing = await getChannelConfig(asInstanceSlug(slug), type);
    const mergedConfig = this.mergeAllowedConfig(existing?.config ?? {}, body.config, type);
    const result = await this.saveChannelConfig(instance.id, type, mergedConfig, body.enabled);

    // Re-fetch so downstream consumers (adapter start, response body) see the
    // config the store actually persisted (pruned + possibly secret-minted),
    // not the pre-normalization value the controller sent in.
    const channel = await getChannelConfig(asInstanceSlug(slug), type);
    const finalConfig = channel?.config ?? mergedConfig;

    await this.syncChannelSideEffects(slug, type, body.enabled, finalConfig, instance.description ?? null);
    if (result.mintedWebhookSecret) this.auditWebhookSecretWrite(slug, user);

    return this.buildChannelResponse(slug, type, channel, finalConfig);
  }

  @RequirePermission(Permission.CHANNEL_WRITE)
  @Delete(":slug/channels/:type")
  async removeChannel(
    @Param("slug") slug: string,
    @Param("type") channelType: string,
  ) {
    const instance = await findInstanceOrFail(slug);
    await channelManager.stopChannel(slug, channelType);
    await deleteChannelConfig(instance.id, channelType as ChannelType);
    if (channelType === "agent") {
      await syncAgentTool({ slug, description: null, enable: false });
    }
    return { deleted: true };
  }
}
