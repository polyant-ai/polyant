// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation a proactive message to a contact belongs to.
 *
 * The inbound pipeline keys a contact's conversation `${slug}:${channel}:${channelId}`,
 * with the channel id the provider puts on the contact's own messages. A configured
 * outbound target can name the same contact another way (Twilio's `whatsapp:+39…`
 * against the inbound `+39…`, a Slack user id against the DM channel the reply arrives
 * on), so a proactive message is recorded under the id the adapter reports for the
 * delivery when there is one, and under `contactChannelId(target)` otherwise. The
 * contact's reply then continues the conversation that holds the message it answers.
 */

/** The channel id the contact's own messages carry, as far as the target alone tells. */
export function contactChannelId(channelType: string, target: string): string {
  if (channelType === "whatsapp") return target.replace(/^whatsapp:/, "");
  return target;
}

/** The conversation id the inbound pipeline gives a contact on a channel. */
export function contactConversationId(instanceSlug: string, channelType: string, channelId: string): string {
  return `${instanceSlug}:${channelType}:${channelId}`;
}
