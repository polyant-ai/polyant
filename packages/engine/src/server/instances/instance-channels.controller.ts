// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import {
  setChannelConfig, listChannelConfigs, getChannelConfig, deleteChannelConfig,
  CHANNEL_TYPES, CHANNEL_CONFIG_KEYS, pruneWhatsAppCredentials, resolveWhatsAppAuthMode,
  type ChannelType,
} from "../../instances/channels.store.js";
import { channelManager } from "../../channels/channel-manager.js";
import { syncAgentTool } from "../../instances/agent-tool-sync.js";
import { findInstanceOrFail, maskSensitiveConfig } from "./instance-helpers.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
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
   */
  @RequirePermission(Permission.CHANNEL_WRITE)
  @Get(":slug/channels/whatsapp/webhook-url")
  async whatsappWebhookUrl(@Param("slug") slug: string) {
    await findInstanceOrFail(slug);
    const channel = await getChannelConfig(asInstanceSlug(slug), "whatsapp");
    const secret = channel && resolveWhatsAppAuthMode(channel.config) === "apiKey"
      ? channel.config.webhookSecret
      : undefined;
    if (typeof secret !== "string" || !secret) {
      throw new NotFoundException("WhatsApp channel is not configured in API Key mode");
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
      throw new NotFoundException("WhatsApp channel is not configured in API Key mode");
    }

    const webhookSecret = generateToken(32);
    const nextConfig = { ...channel.config, webhookSecret };
    await setChannelConfig(instance.id, "whatsapp", nextConfig, channel.enabled);
    if (channel.enabled) {
      await channelManager.startChannel(slug, "whatsapp", nextConfig);
    }

    this.auditLogger.log({
      action: ManagementAuditAction.SecretWrite,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Secret,
      // Key only — the value is never audited.
      targetId: `${slug}:whatsapp.webhookSecret`,
    });

    return { webhookUrl: buildTwilioWhatsAppWebhookUrl(slug, webhookSecret) };
  }

  @RequirePermission(Permission.CHANNEL_WRITE)
  @Put(":slug/channels/:type")
  async setChannel(
    @Param("slug") slug: string,
    @Param("type") channelType: string,
    @Body() body: { config: Record<string, unknown>; enabled: boolean },
  ) {
    if (!CHANNEL_TYPES.includes(channelType as ChannelType)) {
      throw new BadRequestException(`Invalid channel type "${channelType}". Valid: ${CHANNEL_TYPES.join(", ")}`);
    }
    const instance = await findInstanceOrFail(slug);

    // Merge with existing config, walking the ALLOWLIST rather than the request
    // body: no property name written into a stored config may come from remote
    // input. Masked values (••••) are skipped so unchanged secrets survive.
    const existing = await getChannelConfig(asInstanceSlug(slug), channelType as ChannelType);
    const mergedConfig: Record<string, unknown> = { ...(existing?.config ?? {}) };
    // Walk the allowlist, not the body. Every property name written below comes
    // from CHANNEL_CONFIG_KEYS — a module constant — so a caller cannot choose
    // which key it writes, only the value of a key this channel type declares.
    for (const key of CHANNEL_CONFIG_KEYS[channelType as ChannelType]) {
      if (!Object.prototype.hasOwnProperty.call(body.config, key)) continue;
      const v = body.config[key];
      if (typeof v === "string" && v.startsWith("••••")) continue;
      mergedConfig[key] = v;
    }

    const finalConfig =
      channelType === "whatsapp" ? this.prepareWhatsAppConfig(mergedConfig) : mergedConfig;

    try {
      await setChannelConfig(instance.id, channelType as ChannelType, finalConfig, body.enabled);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Validation")) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    if (body.enabled) {
      await channelManager.startChannel(slug, channelType, finalConfig);
    } else {
      await channelManager.stopChannel(slug, channelType);
    }

    // Mirror enable/disable of the virtual `agent` channel into the tools
    // catalog so OTHER instances see this one as a selectable agent target.
    if (channelType === "agent") {
      await syncAgentTool({
        slug,
        description: instance.description ?? null,
        enable: body.enabled,
      });
    }

    const channel = await getChannelConfig(asInstanceSlug(slug), channelType as ChannelType);
    return {
      channel: channel ? {
        channelType: channel.channelType,
        enabled: channel.enabled,
        config: maskSensitiveConfig(channel.config),
      } : null,
    };
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

  /**
   * Prune the unused mode's credentials and mint the inbound secret. The
   * `apiKey` schema variant REQUIRES `webhookSecret` and no client may send one
   * (it is absent from CHANNEL_CONFIG_KEYS), so the server mints it here —
   * before validation, or every first save in that mode would fail its own
   * schema.
   */
  private prepareWhatsAppConfig(merged: Record<string, unknown>): Record<string, unknown> {
    const pruned = pruneWhatsAppCredentials(merged);
    if (resolveWhatsAppAuthMode(pruned) === "apiKey" && !pruned.webhookSecret) {
      return { ...pruned, webhookSecret: generateToken(32) };
    }
    return pruned;
  }
}
