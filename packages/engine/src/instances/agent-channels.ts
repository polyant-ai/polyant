// SPDX-License-Identifier: AGPL-3.0-or-later

import { channelManager } from "../channels/channel-manager.js";
import { syncAgentTool } from "./agent-tool-sync.js";
import { AGENT_CHANNEL_TYPE, WEB_CHANNEL_TYPE, type ChannelType } from "./channels.store.js";
import { resolveInstanceConfig } from "./config-resolver.js";
import { asInstanceSlug } from "./identifiers.js";
import { AgentRequestRefusedError } from "./agent-refusal.js";

/**
 * Refuse switching a channel on when the agent cannot serve it yet. Today only
 * the Web channel has such a precondition: with authentication on, it needs the
 * agent's API key.
 */
export async function assertChannelCanBeEnabled(slug: string, channelType: ChannelType, enabled: boolean): Promise<void> {
  if (channelType !== WEB_CHANNEL_TYPE || !enabled) return;
  const cfg = await resolveInstanceConfig(asInstanceSlug(slug));
  if (cfg.authEnabled && !cfg.authApiKey) {
    throw new AgentRequestRefusedError(
      "Web needs the agent's API key while authentication is on: save a key first",
      "invalid",
      "missing_channel_key",
    );
  }
}

/** Start/stop the channel adapter and mirror the virtual `agent` channel into the tools catalog. */
export async function applyChannelSideEffects(
  slug: string,
  channelType: ChannelType,
  enabled: boolean,
  config: Record<string, unknown>,
  instanceDescription: string | null,
): Promise<void> {
  if (enabled) {
    await channelManager.startChannel(slug, channelType, config);
  } else {
    await channelManager.stopChannel(slug, channelType, { deregister: true });
  }
  await channelManager.announceChange(slug, channelType);
  if (channelType === AGENT_CHANNEL_TYPE) {
    await syncAgentTool({ slug, description: instanceDescription, enable: enabled });
  }
}
