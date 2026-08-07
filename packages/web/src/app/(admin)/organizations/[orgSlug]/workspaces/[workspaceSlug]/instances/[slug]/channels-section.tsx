// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { Send, Hash, MessageCircle, Bot } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Label } from "@/components/ui/label";
import { api, type ChannelConfig, type Instance } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
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
 * Web/API and HTTP are Enterprise channels and are absent here: the panel would
 * offer a page for an adapter this build does not ship.
 */
const CHANNELS: readonly {
  type: string;
  titleKey: TranslationKey;
  icon: LucideIcon;
}[] = [
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
  const [configured, setConfigured] = useState<ChannelConfig[]>([]);

  /*
    The dots come from the PANEL below, which reloads the channel list on every
    save and removal anyway (`onChannelsLoaded`). This effect is only the cold
    start: the Web/API panel is not a channel and never reports a list, so without
    it the picker would open with no dots at all.

    It deliberately does NOT depend on `selected`: keyed on the selection, the
    fetch re-ran when you switched channel — which is exactly why a channel you
    had just switched on kept a stale dot until you navigated away and back.
  */
  useEffect(() => {
    let active = true;
    api.channels
      .list(instance.slug)
      .then((res) => {
        if (active) setConfigured(res.channels);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [instance.slug]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>{t("instances.section.channelsPicker")}</Label>
        <div className="flex flex-wrap gap-2">
          {CHANNELS.map((channel) => {
            const Icon = channel.icon;
            const isSelected = channel.type === selected;
            const live =
              configured.find((c) => c.channelType === channel.type)?.enabled ?? false;

            return (
              <button
                key={channel.type}
                type="button"
                onClick={() => setSelected(channel.type)}
                aria-pressed={isSelected}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  isSelected
                    ? "border-foreground bg-primary text-primary-foreground"
                    : "hover:bg-secondary",
                )}
              >
                <Icon className="h-4 w-4" />
                {t(channel.titleKey)}
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    live ? "bg-success" : "bg-muted-foreground/40",
                  )}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/*
        Keyed by channel: `ChannelsTab` loads and holds the state of the ONE
        channel it is given, so remounting on a change is what keeps the panel's
        dirty state from surviving into a channel it does not belong to.
      */}
      <ChannelsTab
        key={selected}
        slug={instance.slug}
        channelType={selected}
        instance={instance}
        onInstanceUpdate={onUpdate}
        onChannelsLoaded={setConfigured}
      />
    </div>
  );
}
