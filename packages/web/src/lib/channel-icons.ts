// SPDX-License-Identifier: AGPL-3.0-or-later

/** Map a channel type / webhook source to a single-emoji icon. */
export const CHANNEL_ICONS: Record<string, string> = {
  web: "🌐",
  telegram: "✈️",
  whatsapp: "💬",
  slack: "#️⃣",
  email: "✉️",
  room: "🏠",
  scheduled: "⏰",
};

export function channelIcon(name: string): string {
  return CHANNEL_ICONS[name.toLowerCase()] ?? "📡";
}
