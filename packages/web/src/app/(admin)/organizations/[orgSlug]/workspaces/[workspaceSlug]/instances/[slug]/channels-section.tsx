// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Globe, Send, Hash, MessageCircle, Bot } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Instance } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { ChannelWebTab } from "./channel-web-tab";
import { ChannelsTab } from "./channels-tab";

/**
 * Every way in, on ONE page.
 *
 * This was six sidebar sections — one per channel — each holding a switch and at
 * most three fields. Six destinations for six near-empty forms: the cost of
 * getting there dwarfed what was there. Here the channel is picked inside the
 * section, which is also the first place the panel says out loud WHICH channels
 * this agent answers on: the picker carries that state, so "is Telegram live?" no
 * longer means opening Telegram.
 *
 * The picked channel is local state, not a second URL parameter. `?tab=` names the
 * section; a channel is a selection within it. The cost is that a specific
 * channel is not linkable — one click from the section that is — and the gain is
 * that the address stays the one thing the sidebar and the page both read.
 */

/**
 * Web/API leads: every agent has it, and it is the one that used to hide in the
 * model settings as "Autenticazione API". It is a channel like the others (type
 * `web`), with its own panel because its configuration is the agent's
 * authentication rather than a bot token.
 */
const CHANNELS: readonly {
  type: string;
  titleKey: TranslationKey;
  icon: LucideIcon;
}[] = [
  { type: "web", titleKey: "channels.tab.web", icon: Globe },
  { type: "telegram", titleKey: "channels.tab.telegram", icon: Send },
  { type: "slack", titleKey: "channels.tab.slack", icon: Hash },
  { type: "whatsapp", titleKey: "channels.tab.whatsapp", icon: MessageCircle },
  { type: "agent", titleKey: "channels.tab.agent", icon: Bot },
];

export function ChannelsSection({
  instance,
  onUpdate,
}: {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string>(CHANNELS[0].type);
  // The ONE read of the channel list: the picker's dots, the Web panel and the
  // selected channel's panel all work from it. A panel that changes a channel asks
  // for it again (`reload`), so the dots follow a save or a removal; switching
  // between channels reads nothing.
  const { data, reload } = useResource(["channels", instance.slug], () => api.channels.list(instance.slug));
  const channels = data?.channels;

  return (
    <div className="space-y-6">
      <div>
        {/* No label: the section's title above already says "Canali". */}
        <div className="flex flex-wrap gap-2" data-tour="channels-picker" role="group" aria-label={t("instances.section.channelsPicker")}>
          {CHANNELS.map((channel) => {
            const Icon = channel.icon;
            const isSelected = channel.type === selected;
            const live = channels?.find((c) => c.channelType === channel.type)?.enabled ?? false;

            return (
              <Chip
                key={channel.type}
                active={isSelected}
                size="md"
                onClick={() => setSelected(channel.type)}
                aria-pressed={isSelected}
              >
                <Icon className="h-4 w-4" />
                {t(channel.titleKey)}
                <span
                  aria-hidden
                  data-state={live ? "live" : "off"}
                  className={cn(
                    "size-1.5 rounded-full",
                    live ? "bg-success" : "bg-muted-foreground/40",
                  )}
                />
              </Chip>
            );
          })}
        </div>
      </div>

      {/*
        Keyed by channel: `ChannelsTab` holds the edits of the ONE channel it is
        given, so remounting on a change is what keeps the panel's dirty state from
        surviving into a channel it does not belong to.
      */}
      {selected === "web" ? (
        <ChannelWebTab instance={instance} onUpdate={onUpdate} channels={channels} onChannelsChanged={reload} />
      ) : channels === undefined ? (
        <div className="space-y-4">
          <Skeleton className="h-48 rounded-lg" />
        </div>
      ) : (
        <ChannelsTab
          key={selected}
          slug={instance.slug}
          channelType={selected}
          channels={channels}
          onChannelsChanged={reload}
          instance={instance}
          onInstanceUpdate={onUpdate}
        />
      )}
    </div>
  );
}
