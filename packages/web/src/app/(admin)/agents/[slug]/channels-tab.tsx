// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Bot, Eye, EyeOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { api, getUserErrorMessage, type ChannelConfig } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface Props {
  slug: string;
}

interface ChannelState {
  enabled: boolean;
  config: Record<string, string>;
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

export function ChannelsTab({ slug }: Props) {
  const { t } = useI18n();
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [channelStates, setChannelStates] = useState<Record<string, ChannelState>>({});
  const [savingChannel, setSavingChannel] = useState<string | null>(null);
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.channels.list(slug).then((res) => {
      setChannels(res.channels);
      initStates(res.channels);
    }).catch(() => {
      toast.error(t("channels.tab.saveFailed"));
    }).finally(() => setLoading(false));
  }, [slug]);

  function initStates(chList: ChannelConfig[]) {
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

  function toggleEnabled(channelType: string, enabled: boolean) {
    const def = CHANNEL_DEFS.find((d) => d.type === channelType);
    if (def && "noConfig" in def && def.noConfig) {
      // Config-less channels (e.g. agent) auto-save immediately on toggle.
      setChannelStates((prev) => ({
        ...prev,
        [channelType]: { ...prev[channelType], enabled, dirty: false },
      }));
      void handleSaveImmediate(channelType, enabled);
      return;
    }
    setChannelStates((prev) => ({
      ...prev,
      [channelType]: { ...prev[channelType], enabled, dirty: true },
    }));
  }

  async function handleSaveImmediate(channelType: string, enabled: boolean) {
    setSavingChannel(channelType);
    try {
      await api.channels.set(slug, channelType, {}, enabled);
      const res = await api.channels.list(slug);
      setChannels(res.channels);
      initStates(res.channels);
      toast.success(t("channels.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.saveFailed")));
    } finally {
      setSavingChannel(null);
    }
  }

  function toggleFieldVisibility(fieldId: string) {
    setVisibleFields((prev) => ({ ...prev, [fieldId]: !prev[fieldId] }));
  }

  async function handleSave(channelType: string) {
    const state = channelStates[channelType];
    if (!state) return;

    setSavingChannel(channelType);
    try {
      // Only send fields the user actually changed (non-empty)
      const mergedConfig: Record<string, string> = {};
      for (const [k, v] of Object.entries(state.config)) {
        if (v !== "") mergedConfig[k] = v;
      }

      await api.channels.set(slug, channelType, mergedConfig, state.enabled);

      // Refresh from server
      const res = await api.channels.list(slug);
      setChannels(res.channels);
      initStates(res.channels);

      toast.success(t("channels.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.saveFailed")));
    } finally {
      setSavingChannel(null);
    }
  }

  async function handleRemove(channelType: string) {
    try {
      await api.channels.delete(slug, channelType);
      const res = await api.channels.list(slug);
      setChannels(res.channels);
      initStates(res.channels);
      toast.success(t("channels.tab.removed"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.removeFailed")));
    }
  }

  if (loading) {
    return <div className="max-w-2xl animate-pulse space-y-4">
      <div className="h-48 rounded-lg bg-muted" />
      <div className="h-48 rounded-lg bg-muted" />
      <div className="h-48 rounded-lg bg-muted" />
    </div>;
  }

  return (
    <div className="max-w-2xl space-y-8">
      <p className="text-sm text-muted-foreground">{t("channels.tab.description")}</p>

      {CHANNEL_DEFS.map((def) => {
        const state = channelStates[def.type];
        if (!state) return null;
        const existingChannel = channels.find((c) => c.channelType === def.type);
        const isConfigured = !!existingChannel;
        const isNoConfig = "noConfig" in def && def.noConfig;

        return (
          <section key={def.type} className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  {isNoConfig && <Bot className="h-4 w-4 text-muted-foreground" />}
                  <Label className="text-base font-medium">{t(def.nameKey)}</Label>
                  {isConfigured && (
                    <Badge variant={existingChannel.enabled ? "default" : "secondary"} className="text-xs">
                      {existingChannel.enabled ? t("channels.tab.enabled") : t("channels.tab.disabled")}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{t(def.helpKey)}</p>
              </div>
              <div className="flex items-center gap-2">
                {isConfigured && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-destructive">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("channels.tab.removeTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>{t("channels.tab.removeDescription")}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleRemove(def.type)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {t("common.delete")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
                <Switch
                  checked={state.enabled}
                  onCheckedChange={(checked) => toggleEnabled(def.type, checked)}
                  disabled={savingChannel === def.type}
                />
              </div>
            </div>

            {def.fields.map((field) => {
              const fieldId = `${def.type}-${field.key}`;
              const existingValue = state.existingConfig[field.key];
              const maskedValue = typeof existingValue === "string" ? existingValue : "";
              const isSet = !!maskedValue;
              const visible = visibleFields[fieldId] ?? false;

              return (
                <div key={field.key} className="space-y-1">
                  <Label>{t(field.labelKey)}</Label>
                  {"helpKey" in field && field.helpKey && (
                    <p className="text-xs text-muted-foreground">{t(field.helpKey)}</p>
                  )}
                  <div className="relative">
                    <Input
                      type={field.sensitive && !visible ? "password" : "text"}
                      value={state.config[field.key] ?? ""}
                      onChange={(e) => updateField(def.type, field.key, e.target.value)}
                      placeholder={isSet ? maskedValue : ""}
                    />
                    {field.sensitive && (
                      <button
                        type="button"
                        onClick={() => toggleFieldVisibility(fieldId)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {state.dirty && !isNoConfig && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => handleSave(def.type)}
                  disabled={savingChannel === def.type}
                >
                  {savingChannel === def.type ? t("common.saving") : t("common.saveSingle")}
                </Button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
