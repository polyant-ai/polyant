// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, getUserErrorMessage, type ChannelConfig, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";
import { WhatsAppChannelCard } from "./whatsapp-channel-card";
import { ChannelSection } from "./channel-section";

interface Props {
  slug: string;
  /**
   * The ONE channel this section is for. Each channel is its own sidebar section
   * now, so five credential forms are no longer stacked on one page — but the load
   * stays a single `channels.list` call, because a channel's enabled state is read
   * from the same list either way.
   */
  channelType: string;
  /**
   * Only read by the Agent-to-Agent section, for the A2A switch. A2A is NOT a
   * channel — it is a column on `instances` — but it answers the same question
   * the `agent` channel does ("who else may drive this agent"), and the two used
   * to sit on different pages with nothing saying they were related.
   */
  instance: Instance;
  onInstanceUpdate: (instance: Instance) => void;
  /**
   * Every time this panel learns the channel list — on load, and after a save or a
   * removal — so the picker above it can repaint its live dots.
   *
   * The picker used to re-fetch the list itself, keyed on which channel was
   * selected: switching a channel on left its dot stale until you navigated to
   * another channel and back, because nothing told the picker anything had
   * changed. Pushing the list up from the one component that already reloads it
   * costs no extra request.
   */
  onChannelsLoaded?: (channels: ChannelConfig[]) => void;
}

export interface ChannelState {
  enabled: boolean;
  config: Record<string, unknown>;
  existingConfig: Record<string, unknown>;
  dirty: boolean;
}

const CHANNEL_DEFS = [
  {
    type: "telegram",
    nameKey: "channels.tab.telegram" as const,
    helpKey: "channels.tab.telegramHelp" as const,
    fields: [
      { key: "botToken", labelKey: "channels.tab.telegramBotToken" as const, sensitive: true },
      { key: "allowedUserIds", labelKey: "channels.tab.telegramAllowedUserIds" as const, sensitive: false, helpKey: "channels.tab.telegramAllowedUserIdsHelp" as const },
    ],
  },
  {
    type: "slack",
    nameKey: "channels.tab.slack" as const,
    helpKey: "channels.tab.slackHelp" as const,
    fields: [
      { key: "botToken", labelKey: "channels.tab.slackBotToken" as const, sensitive: true },
      { key: "appToken", labelKey: "channels.tab.slackAppToken" as const, sensitive: true },
      { key: "signingSecret", labelKey: "channels.tab.slackSigningSecret" as const, sensitive: true },
    ],
  },
  {
    type: "whatsapp",
    nameKey: "channels.tab.whatsapp" as const,
    helpKey: "channels.tab.whatsappHelp" as const,
    // Rendered by WhatsAppChannelCard — two mutually exclusive credential
    // modes plus a secret-bearing webhook URL do not fit the generic
    // field-list renderer below. Kept in this list (with empty fields) so
    // the channel picker above still lists it like every other channel.
    fields: [] as { key: string; labelKey: "channels.tab.whatsapp"; sensitive: boolean }[],
    custom: true,
  },
  {
    type: "agent",
    nameKey: "channels.tab.agent" as const,
    helpKey: "channels.tab.agentHelp" as const,
    fields: [] as { key: string; labelKey: "channels.tab.agent"; sensitive: boolean }[],
    noConfig: true,
  },
];

export type ChannelDef = (typeof CHANNEL_DEFS)[number];

export function ChannelsTab({
  slug,
  channelType,
  instance,
  onInstanceUpdate,
  onChannelsLoaded,
}: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [channelStates, setChannelStates] = useState<Record<string, ChannelState>>({});
  // Raw list, kept alongside the derived `channelStates`: WhatsAppChannelCard
  // owns its own form state and needs the untransformed ChannelConfig (with
  // `authMode` and — in apiKey mode — the masked credentials), not the
  // flattened shape the generic field-list renderer works from.
  const [rawChannels, setRawChannels] = useState<ChannelConfig[]>([]);
  const [savingChannel, setSavingChannel] = useState<string | null>(null);
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({});

  // This tab renders exactly ONE channel (`channelType`), so "the section you are
  // in" is unambiguous and its save belongs to the page's own action, beside
  // Export — the same place every other tab puts it. It used to own an inline
  // button that MATERIALISED when the section went dirty: a control appearing from
  // nothing is harder to find than a stable one that is merely disabled, and it
  // read as a different affordance from the Save every neighbouring tab has.
  const current = channelStates[channelType];
  const [a2aEnabled, setA2aEnabled] = useState(instance.a2aEnabled);
  const [savingA2a, setSavingA2a] = useState(false);
  const a2aDirty = channelType === "agent" && a2aEnabled !== instance.a2aEnabled;

  /**
   * A2A persists through the INSTANCE endpoint, the channel through its own, so
   * the page's one Save may touch two resources. Each is written only when it
   * actually changed, and the channel goes first: there is no transaction across
   * two endpoints, so if the second fails the first stands — and the channel is
   * the one whose state the section is otherwise about.
   */
  async function handleSaveA2a() {
    setSavingA2a(true);
    try {
      const { instance: updated } = await api.instances.update(slug, { a2aEnabled });
      onInstanceUpdate(updated);
    } finally {
      setSavingA2a(false);
    }
  }

  usePageSaveAction({
    isDirty: current?.dirty === true || a2aDirty,
    saving: savingChannel === channelType || savingA2a,
    onSave: async () => {
      if (current?.dirty) await handleSave(channelType);
      if (a2aDirty) await handleSaveA2a();
    },
  });

  useEffect(() => {
    api.channels.list(slug).then((res) => {
      initStates(res.channels);
    }).catch(() => {
      toast.error(t("channels.tab.saveFailed"));
    }).finally(() => setLoading(false));
  }, [slug, t]);

  function initStates(chList: ChannelConfig[]) {
    onChannelsLoaded?.(chList);
    setRawChannels(chList);
    const states: Record<string, ChannelState> = {};
    for (const def of CHANNEL_DEFS) {
      const existing = chList.find((c) => c.channelType === def.type);
      states[def.type] = {
        enabled: existing?.enabled ?? false,
        config: {},
        existingConfig: existing?.config ?? {},
        dirty: false,
      };
    }
    setChannelStates(states);
  }

  function updateField(channelType: string, key: string, value: string) {
    setChannelStates((prev) => ({
      ...prev,
      [channelType]: {
        ...prev[channelType],
        config: { ...prev[channelType].config, [key]: value },
        dirty: true,
      },
    }));
  }

  /**
   * The switch marks the section dirty; the page's Save persists it.
   *
   * A config-less channel (Agent-to-Agent) used to PERSIST on the flick, with no
   * Save involved — the one channel in the tab that behaved differently, and a
   * write nobody asked for. `handleSave` already copes with an empty config, so
   * there is nothing the immediate path did that the ordinary one cannot.
   */
  function toggleEnabled(channelType: string, enabled: boolean) {
    setChannelStates((prev) => ({
      ...prev,
      [channelType]: { ...prev[channelType], enabled, dirty: true },
    }));
  }


  function toggleFieldVisibility(fieldId: string) {
    setVisibleFields((prev) => ({ ...prev, [fieldId]: !prev[fieldId] }));
  }

  async function handleSave(channelType: string) {
    const state = channelStates[channelType];
    if (!state) return;

    setSavingChannel(channelType);
    try {
      // Flat channels only here: the HTTP channel's structured config is an
      // Enterprise feature, so there is one shape to send.
      // Only the fields the user actually changed (non-empty). Every channel here
      // is flat: the HTTP channel's structured config is an Enterprise feature.
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(state.config)) {
        if (v !== "") payload[k] = v;
      }

      await api.channels.set(slug, channelType, payload, state.enabled);

      // Refresh from server
      const res = await api.channels.list(slug);
      initStates(res.channels);

      toast.success(t("channels.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.saveFailed")));
    } finally {
      setSavingChannel(null);
    }
  }


  if (loading) {
    return <div className="animate-pulse space-y-4">
      <div className="h-48 rounded-lg bg-muted" />
      <div className="h-48 rounded-lg bg-muted" />
      <div className="h-48 rounded-lg bg-muted" />
    </div>;
  }

  return (
    <div className="space-y-8">
      {CHANNEL_DEFS.filter((def) => def.type === channelType).map((def) => {
        const state = channelStates[def.type];
        if (!state) return null;

        // WhatsApp owns its own form (two mutually exclusive credential
        // modes plus a secret-bearing webhook URL) and its own inline Save —
        // it does not participate in this page's shared save action.
        if ("custom" in def && def.custom) {
          return (
            <WhatsAppChannelCard
              key={def.type}
              slug={slug}
              channel={rawChannels.find((c) => c.channelType === def.type) ?? null}
              onChanged={() => {
                void api.channels.list(slug).then((res) => initStates(res.channels));
              }}
            />
          );
        }

        return (
          <ChannelSection
            key={def.type}
            def={def}
            state={state}
            savingChannel={savingChannel}
            visibleFields={visibleFields}
            onToggleEnabled={toggleEnabled}
            onUpdateField={updateField}
            onToggleFieldVisibility={toggleFieldVisibility}
            a2aEnabled={a2aEnabled}
            onA2aEnabledChange={setA2aEnabled}
          />
        );
      })}
    </div>
  );
}
