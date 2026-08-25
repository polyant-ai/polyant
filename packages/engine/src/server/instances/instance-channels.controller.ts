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
  WHATSAPP_CHANNEL_TYPE, WHATSAPP_AUTH_MODE_API_KEY, AGENT_CHANNEL_TYPE,
  type ChannelType, type SetChannelConfigResult, type SetChannelConfigOptions,
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

/** Thrown by `whatsappWebhookUrl` and `rotateWhatsappWebhookSecret` below. */
const WHATSAPP_NOT_IN_API_KEY_MODE = "WhatsApp channel is not configured in API Key mode";

/** The `targetId` shared by every audit row for the WhatsApp inbound webhook secret — key only, never the value. */
function webhookSecretAuditTargetId(slug: string): string {
  return `${slug}:whatsapp.webhookSecret`;
}

/** A Zod parse failure — the only error shape `setChannelConfig` throws for invalid input. */
function isChannelConfigValidationError(err: unknown): err is ZodError {
  return err instanceof ZodError;
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
    const channel = await getChannelConfig(asInstanceSlug(slug), WHATSAPP_CHANNEL_TYPE);
    const secret = channel && resolveWhatsAppAuthMode(channel.config) === WHATSAPP_AUTH_MODE_API_KEY
      ? channel.config.webhookSecret
      : undefined;
    if (typeof secret !== "string" || !secret) {
      throw new NotFoundException(WHATSAPP_NOT_IN_API_KEY_MODE);
    }
    return { webhookUrl: buildTwilioWhatsAppWebhookUrl(slug, secret) };
  }

  /**
   * Rotate the inbound secret. The previous URL stops working immediately.
   * The new value travels ONLY through `rotateWebhookSecretTo` — never inside
   * the `config` argument — so the store, not this handler, is what decides
   * the persisted secret (see `setChannelConfig` in `channels.store.ts`).
   */
  @RequirePermission(Permission.CHANNEL_WRITE)
  @Post(":slug/channels/whatsapp/rotate-webhook-secret")
  async rotateWhatsappWebhookSecret(
    @Param("slug") slug: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const instance = await findInstanceOrFail(slug);
    const channel = await getChannelConfig(asInstanceSlug(slug), WHATSAPP_CHANNEL_TYPE);
    if (!channel || resolveWhatsAppAuthMode(channel.config) !== WHATSAPP_AUTH_MODE_API_KEY) {
      throw new NotFoundException(WHATSAPP_NOT_IN_API_KEY_MODE);
    }

    const webhookSecret = generateToken(32);
    const configWithoutSecret: Record<string, unknown> = { ...channel.config };
    delete configWithoutSecret.webhookSecret;
    const result = await this.saveChannelConfig(
      instance.id,
      WHATSAPP_CHANNEL_TYPE,
      configWithoutSecret,
      channel.enabled,
      { rotateWebhookSecretTo: webhookSecret },
    );

    // Audit BEFORE the side-effecting adapter restart: the write already
    // happened, so the audit row must exist even if the restart below fails.
    this.auditWebhookSecretWrite(slug, user);
    if (channel.enabled) {
      await channelManager.startChannel(slug, WHATSAPP_CHANNEL_TYPE, result.config);
    }

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
    // Walk the allowlist, not the body. Every property name written below
    // comes from CHANNEL_CONFIG_KEYS — a module constant — so a caller cannot
    // choose which key it writes, only the value of a key this channel type
    // declares. `hasOwnProperty` (not `in`) so an inherited/prototype
    // property can never be mistaken for a client-supplied value.
    for (const key of CHANNEL_CONFIG_KEYS[channelType]) {
      if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
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
    options?: SetChannelConfigOptions,
  ): Promise<SetChannelConfigResult> {
    try {
      return await setChannelConfig(instanceId, channelType, config, enabled, options);
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
      targetId: webhookSecretAuditTargetId(slug),
    });
  }

  /**
   * Audit the destruction of an inbound secret — a save that switches
   * `authMode` away from `apiKey` runs `pruneWhatsAppCredentials` and
   * discards the existing `webhookSecret`, permanently killing the only
   * authenticator of an internet-facing route. The store reports what it
   * persisted (`SetChannelConfigResult`); it has no actor to audit with, so
   * this compares that result against the config already read before the
   * save (`existing`, fetched by `setChannel` for the allowlist merge) —
   * the same seam `auditWebhookSecretWrite` uses for minting.
   */
  private auditWebhookSecretDeleteIfDiscarded(
    slug: string,
    existingConfig: Record<string, unknown> | undefined,
    finalConfig: Record<string, unknown>,
    user: AuthenticatedUser | undefined,
  ): void {
    const hadSecret = typeof existingConfig?.webhookSecret === "string" && existingConfig.webhookSecret.length > 0;
    const hasSecret = typeof finalConfig.webhookSecret === "string" && finalConfig.webhookSecret.length > 0;
    if (!hadSecret || hasSecret) return;

    this.auditLogger.log({
      action: ManagementAuditAction.SecretDelete,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Secret,
      // Key only — the discarded value is never audited.
      targetId: webhookSecretAuditTargetId(slug),
    });
  }

  /** The full webhook URL when the saved channel ended up in apiKey mode, else undefined. */
  private buildWebhookUrlIfApiKeyMode(
    slug: string,
    channelType: ChannelType,
    config: Record<string, unknown>,
  ): string | undefined {
    if (channelType !== WHATSAPP_CHANNEL_TYPE || resolveWhatsAppAuthMode(config) !== WHATSAPP_AUTH_MODE_API_KEY) {
      return undefined;
    }
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
    if (channelType === AGENT_CHANNEL_TYPE) {
      await syncAgentTool({ slug, description: instanceDescription, enable: enabled });
    }
  }

  /** Build the masked channel + optional webhookUrl response shape shared by `setChannel`. */
  private buildChannelResponse(
    slug: string,
    channelType: ChannelType,
    enabled: boolean,
    persistedConfig: Record<string, unknown>,
  ) {
    const webhookUrl = this.buildWebhookUrlIfApiKeyMode(slug, channelType, persistedConfig);
    return {
      channel: { channelType, enabled, config: maskSensitiveConfig(persistedConfig) },
      ...(webhookUrl ? { webhookUrl } : {}),
    };
  }

  // `no-store`: for whatsapp/apiKey the response body carries the inbound
  // webhook URL, which embeds the bearer-equivalent webhookSecret — same
  // reason as the GET .../webhook-url route above.
  @RequirePermission(Permission.CHANNEL_WRITE)
  @Header("Cache-Control", "no-store")
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

    // Use what the store actually persisted (pruned + possibly secret-minted)
    // directly from its return value — NOT a post-save re-fetch. A re-fetch
    // that raced a concurrent delete/disable would return null and silently
    // drop a freshly minted secret from the response, which is exactly the
    // failure the webhookUrl-in-response contract exists to prevent.
    const finalConfig = result.config;

    // Audit BEFORE the side-effecting adapter start/stop: the write already
    // happened, so the audit row must exist even if the side effect fails.
    if (result.mintedWebhookSecret) this.auditWebhookSecretWrite(slug, user);
    this.auditWebhookSecretDeleteIfDiscarded(slug, existing?.config, finalConfig, user);
    await this.syncChannelSideEffects(slug, type, body.enabled, finalConfig, instance.description ?? null);

    return this.buildChannelResponse(slug, type, body.enabled, finalConfig);
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
    if (channelType === AGENT_CHANNEL_TYPE) {
      await syncAgentTool({ slug, description: null, enable: false });
    }
    return { deleted: true };
  }
}
