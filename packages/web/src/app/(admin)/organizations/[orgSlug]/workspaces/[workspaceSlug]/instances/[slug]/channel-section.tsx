// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import type { ChannelDef, ChannelState } from "./channels-tab";

interface Props {
  def: ChannelDef;
  state: ChannelState;
  savingChannel: string | null;
  visibleFields: Record<string, boolean>;
  onToggleEnabled: (channelType: string, enabled: boolean) => void;
  onUpdateField: (channelType: string, key: string, value: string) => void;
  onToggleFieldVisibility: (fieldId: string) => void;
  a2aEnabled: boolean;
  onA2aEnabledChange: (value: boolean) => void;
}

/**
 * The generic field-list section for one channel — everything a channel gets
 * unless it opted out with its own dedicated card (WhatsApp; see
 * `WhatsAppChannelCard`). Split out of `ChannelsTab` (issue #287): the tab's
 * render body carried this AND the load/save/dirty-tracking plumbing, well
 * past the project's function-length rule.
 *
 * `def.type` is always the tab's own `channelType` — `ChannelsTab` renders
 * exactly one channel, and this is that channel's section — so there is no
 * separate "which channel is this" prop to keep in sync with `def`.
 */
export function ChannelSection({
  def,
  state,
  savingChannel,
  visibleFields,
  onToggleEnabled,
  onUpdateField,
  onToggleFieldVisibility,
  a2aEnabled,
  onA2aEnabledChange,
}: Props) {
  const { t } = useI18n();

  return (
    <section className="space-y-4 rounded-lg border p-4">
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
                onClick={() => onToggleEnabled(def.type, on)}
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
                onChange={(e) => onUpdateField(def.type, field.key, e.target.value)}
                placeholder={isSet ? maskedValue : ""}
                disabled={!state.enabled}
              />
              {field.sensitive && (
                <button
                  type="button"
                  onClick={() => onToggleFieldVisibility(fieldId)}
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
      {def.type === "agent" && (
        <div className="flex items-start justify-between gap-4 border-t pt-4">
          <div className="space-y-1">
            <Label className="text-sm font-medium">{t("channels.tab.a2a")}</Label>
            <p className="text-sm text-muted-foreground">{t("channels.tab.a2aHelp")}</p>
          </div>
          <Switch checked={a2aEnabled} onCheckedChange={onA2aEnabledChange} />
        </div>
      )}
    </section>
  );
}
