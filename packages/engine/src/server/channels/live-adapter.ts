// SPDX-License-Identifier: AGPL-3.0-or-later

import { NotFoundException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { channelManager } from "../../channels/channel-manager.js";
import type { ChannelAdapter } from "../../channels/types.js";
import { getChannelConfig, type ChannelType } from "../../instances/channels.store.js";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { resolveInstanceId } from "../../instances/resolve-instance-id.js";
import { throttleTracker, channelWebhookBucket } from "../throttle-tracker.js";

export type AdapterUnavailableReason =
  | "instance not found"
  | "channel not configured or disabled"
  | "adapter not active";

/**
 * The running adapter behind a public channel webhook, or a 404.
 *
 * Every webhook route asks the same three questions before it verifies a
 * signature: does the agent exist, is this channel enabled for it, is its
 * adapter running in this process. They all answer with ONE caller-facing
 * message, so an anonymous caller cannot tell which slugs exist or which
 * channels they run; `log` receives the real reason for the server log.
 */
export async function requireLiveAdapter<A extends ChannelAdapter>(
  instanceSlug: string,
  channelType: ChannelType,
  unavailable: { message: string; log?: (reason: AdapterUnavailableReason) => void },
): Promise<{ adapter: A; config: Record<string, unknown> }> {
  const slug = asInstanceSlug(instanceSlug);
  const [id, channel] = await Promise.all([resolveInstanceId(slug), getChannelConfig(slug, channelType)]);
  const refuse = (reason: AdapterUnavailableReason): NotFoundException => {
    unavailable.log?.(reason);
    return new NotFoundException(unavailable.message);
  };
  if (!id) throw refuse("instance not found");
  if (!channel?.enabled) throw refuse("channel not configured or disabled");
  const adapter = channelManager.getAdapter(slug, channelType) as A | undefined;
  if (!adapter) throw refuse("adapter not active");
  return { adapter, config: channel.config };
}

/**
 * Throttle tracker for a public channel webhook route (`:instanceSlug` in the
 * path): one bucket per agent and sending address, see `channelWebhookBucket`.
 * For `@Throttle({ default: { ..., getTracker: channelWebhookTracker("telegram") } })`.
 */
export function channelWebhookTracker(channelType: ChannelType) {
  return (req: Record<string, unknown>, _context?: ExecutionContext): string => {
    const request = req as Parameters<typeof throttleTracker>[0] & { params?: Record<string, unknown> };
    const slug = request.params?.instanceSlug;
    const live = typeof slug === "string" && channelManager.getAdapter(slug, channelType) !== undefined;
    return live ? channelWebhookBucket(request, `${channelType}:${slug}`) : throttleTracker(request);
  };
}
