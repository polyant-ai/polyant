// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Body,
  BadRequestException,
} from "@nestjs/common";
import {
  setChannelConfig, listChannelConfigs, getChannelConfig, deleteChannelConfig,
  CHANNEL_TYPES, type ChannelType,
} from "../../instances/channels.store.js";
import { channelManager } from "../../channels/channel-manager.js";
import { syncAgentTool } from "../../instances/agent-tool-sync.js";
import { findInstanceOrFail, maskSensitiveConfig } from "./instance-helpers.js";
import { asAgentSlug } from "../../instances/identifiers.js";
import { RequirePermission, Permission } from "../../authz/index.js";

@Controller(["api/agents", "api/instances"])
export class InstanceChannelsController {
  @RequirePermission(Permission.CHANNEL_READ)
  @Get(":slug/channels")
  async listChannels(@Param("slug") slug: string) {
    await findInstanceOrFail(slug);
    const channels = await listChannelConfigs(asAgentSlug(slug));
    const masked = channels.map((ch) => ({
      channelType: ch.channelType,
      enabled: ch.enabled,
      config: maskSensitiveConfig(ch.config),
    }));
    return { channels: masked };
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

    // Merge with existing config: drop masked values (••••), preserve unchanged secrets
    const existing = await getChannelConfig(asAgentSlug(slug), channelType as ChannelType);
    const mergedConfig: Record<string, unknown> = { ...(existing?.config ?? {}) };
    for (const [k, v] of Object.entries(body.config)) {
      if (typeof v === "string" && v.startsWith("••••")) continue;
      mergedConfig[k] = v;
    }

    try {
      await setChannelConfig(instance.id, channelType as ChannelType, mergedConfig, body.enabled);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Validation")) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    if (body.enabled) {
      await channelManager.startChannel(slug, channelType, mergedConfig);
    } else {
      await channelManager.stopChannel(slug, channelType);
    }

    // Mirror enable/disable of the virtual `agent` channel into the tools
    // catalog so OTHER agents see this one as a selectable agent target.
    if (channelType === "agent") {
      await syncAgentTool({
        slug,
        description: instance.description ?? null,
        enable: body.enabled,
      });
    }

    const channel = await getChannelConfig(asAgentSlug(slug), channelType as ChannelType);
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
}
