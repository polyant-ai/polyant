// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, getUserErrorMessage, type ChannelConfig, type Instance } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

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

interface ChannelState {
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
    fields: [
      { key: "accountSid", labelKey: "channels.tab.whatsappAccountSid" as const, sensitive: true },
      { key: "authToken", labelKey: "channels.tab.whatsappAuthToken" as const, sensitive: true },
      { key: "whatsappNumber", labelKey: "channels.tab.whatsappNumber" as const, sensitive: false },
    ],
  },
  {
    type: "agent",
    nameKey: "channels.tab.agent" as const,
    helpKey: "channels.tab.agentHelp" as const,
    fields: [] as { key: string; labelKey: "channels.tab.agent"; sensitive: boolean }[],
    noConfig: true,
  },
];

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

        return (
          <section key={def.type} className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                {/* No channel name and no state badge: the picker above carries the
                    channel AND its live dot, so a "Abilitato" badge here said the
                    same thing a second time — and only on channels that happened to
                    be configured, which is why some sections had it and others did
                    not. */}
                {/* Named only here: this is the one section holding TWO controls,
                    and an unnamed switch beside a named one reads as a caption for
                    it rather than as a control of its own. */}
                {def.type === "agent" && (
                  <Label className="text-sm font-medium">{t("channels.tab.agentInternal")}</Label>
                )}
                <p className="text-sm text-muted-foreground">{t(def.helpKey)}</p>
              </div>
              <div className="flex items-center gap-2">
                {/*
                  ON/OFF as two joined buttons, not a switch.

                  A switch shows a POSITION and leaves you to read which end is
                  which — which is why it needed a word beside it, and why before
                  that it needed the label "Canale attivo" that only repeated what
                  a switch means. Two segments state both options and highlight the
                  one in force: nothing to interpret, and the same control shape the
                  channel picker above already uses.

                  The Trash that sat here is gone: it removed the channel's stored
                  config, which for the person looking at it was indistinguishable
                  from switching it off — a destructive-looking control for a state
                  this one already owns.
                */}
                <div
                  role="group"
                  aria-label={t("channels.enabledLabel")}
                  className="inline-flex overflow-hidden rounded-md border"
                >
                  {[true, false].map((on) => (
                    <button
                      key={String(on)}
                      type="button"
                      aria-pressed={state.enabled === on}
                      disabled={savingChannel === def.type}
                      onClick={() => toggleEnabled(def.type, on)}
                      className={cn(
                        "px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
                        on ? "border-r" : undefined,
                        state.enabled === on
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      {t(on ? "common.on" : "common.off")}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/*
              Credentials are unreachable while the channel is off. Typing a bot
              token into a channel that will not run is work with no outcome, and
              the form gave no sign of it — the fields looked exactly as they do
              when the channel is live.
            */}
            {!state.enabled && def.fields.length > 0 && (
              <p className="text-sm text-muted-foreground">{t("channels.disabledHint")}</p>
            )}

            {def.fields.map((field) => {
              const fieldId = `${def.type}-${field.key}`;
              const existingValue = state.existingConfig[field.key];
              const maskedValue = typeof existingValue === "string" ? existingValue : "";
              const isSet = !!maskedValue;
              const visible = visibleFields[fieldId] ?? false;

              return (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={fieldId}>{t(field.labelKey)}</Label>
                  {"helpKey" in field && field.helpKey && (
                    <p className="text-xs text-muted-foreground">{t(field.helpKey)}</p>
                  )}
                  <div className="relative">
                    <Input
                      id={fieldId}
                      type={field.sensitive && !visible ? "password" : "text"}
                      value={(state.config[field.key] as string | undefined) ?? ""}
                      onChange={(e) => updateField(def.type, field.key, e.target.value)}
                      placeholder={isSet ? maskedValue : ""}
                      disabled={!state.enabled}
                    />
                    {field.sensitive && (
                      <button
                        type="button"
                        onClick={() => toggleFieldVisibility(fieldId)}
                        aria-label={t(visible ? "common.hide" : "common.show")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}


            {/*
              A2A lives HERE, under Agent-to-Agent, because both answer "who else
              may drive this agent" — and they are not the same answer, which is
              why the copy names the difference rather than leaving it to be
              inferred from two switches sitting together:

                the switch above  — agents INSIDE this deployment, in-process,
                                    no network, nothing to configure;
                the switch below  — agents OUTSIDE it, over HTTP, through the
                                    Agent2Agent protocol, authenticated by this
                                    agent's own API key.

              The second one is a public surface, so the copy says what turning it
              on exposes and what authenticates it. Note the coupling worth
              knowing: with API authentication off, the A2A endpoint accepts an
              unauthenticated caller who can then drive full turns.

              No inline Save here, unlike the OSS panel: this build gives the page
              ONE save action (`usePageSaveAction`), and a button that materialises
              from nothing is what that convention exists to avoid.
            */}
            {channelType === "agent" && (
              <div className="flex items-start justify-between gap-4 border-t pt-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">{t("channels.tab.a2a")}</Label>
                  <p className="text-sm text-muted-foreground">{t("channels.tab.a2aHelp")}</p>
                </div>
                <Switch checked={a2aEnabled} onCheckedChange={setA2aEnabled} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
