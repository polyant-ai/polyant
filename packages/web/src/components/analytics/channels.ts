// SPDX-License-Identifier: AGPL-3.0-or-later

/** A channel as the dashboard writes it: the engine's name, capitalised ("whatsapp" → "Whatsapp"). */
export function channelLabel(channel: string): string {
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}
