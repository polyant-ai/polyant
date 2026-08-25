// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react";
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
import type { TranslationKey } from "@/lib/i18n/types";

type AuthMode = "authToken" | "apiKey";

interface Props {
  slug: string;
  channel: ChannelConfig | null;
  onChanged: () => void;
}

interface ChannelField {
  key: string;
  labelKey: TranslationKey;
  sensitive: boolean;
}

/** Field sets per credential mode. `accountSid` and `whatsappNumber` are common. */
const MODE_FIELDS: Record<AuthMode, ChannelField[]> = {
  authToken: [{ key: "authToken", labelKey: "channels.tab.whatsappAuthToken", sensitive: true }],
  apiKey: [
    { key: "apiKeySid", labelKey: "channels.tab.whatsappApiKeySid", sensitive: true },
    { key: "apiKeySecret", labelKey: "channels.tab.whatsappApiKeySecret", sensitive: true },
  ],
};

/**
 * WhatsApp is the only channel with two mutually exclusive credential shapes
 * plus a webhook URL to hand back to the operator, so it gets a dedicated card
 * instead of bending the generic field-list renderer in channels-tab.
 */
export function WhatsAppChannelCard({ slug, channel, onChanged }: Props) {
  const { t } = useI18n();
  const storedMode: AuthMode = channel?.config?.authMode === "apiKey" ? "apiKey" : "authToken";

  const [mode, setMode] = useState<AuthMode>(storedMode);
  const [enabled, setEnabled] = useState(channel?.enabled ?? false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadWebhookUrl = useCallback(async () => {
    // Only an apiKey channel has a secret-bearing URL, and only after its
    // first save (the secret is minted server-side at that point).
    if (storedMode !== "apiKey" || !channel) {
      setWebhookUrl(null);
      return;
    }
    try {
      const res = await api.channels.webhookUrl(slug);
      setWebhookUrl(res.webhookUrl);
    } catch {
      setWebhookUrl(null);
    }
  }, [slug, storedMode, channel]);

  useEffect(() => {
    void loadWebhookUrl();
  }, [loadWebhookUrl]);

  function updateValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function changeMode(next: AuthMode) {
    setMode(next);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      // Send only fields the operator actually filled in; the server merges
      // with the stored config and drops masked placeholders.
      const config: Record<string, string> = { authMode: mode };
      for (const [k, v] of Object.entries(values)) {
        if (v !== "") config[k] = v;
      }
      const result = await api.channels.set(slug, "whatsapp", config, enabled);
      toast.success(t("channels.tab.saved"));
      setValues({});
      setDirty(false);
      if (result.webhookUrl) {
        // The PUT response already carries the URL when the saved channel
        // ended up in apiKey mode — avoids a redundant GET round trip.
        setWebhookUrl(result.webhookUrl);
      } else if (mode === "apiKey") {
        await loadWebhookUrl();
      } else {
        setWebhookUrl(null);
      }
      onChanged();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    try {
      const res = await api.channels.rotateWebhookSecret(slug);
      setWebhookUrl(res.webhookUrl);
      toast.success(t("channels.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.saveFailed")));
    }
  }

  async function remove() {
    try {
      await api.channels.delete(slug, "whatsapp");
      toast.success(t("channels.tab.removed"));
      onChanged();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.removeFailed")));
    }
  }

  const fields: ChannelField[] = [
    { key: "accountSid", labelKey: "channels.tab.whatsappAccountSid", sensitive: true },
    ...MODE_FIELDS[mode],
    { key: "whatsappNumber", labelKey: "channels.tab.whatsappNumber", sensitive: false },
  ];

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Label className="text-base font-medium">{t("channels.tab.whatsapp")}</Label>
            {channel && (
              <Badge variant={channel.enabled ? "default" : "secondary"} className="text-xs">
                {channel.enabled ? t("channels.tab.enabled") : t("channels.tab.disabled")}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{t("channels.tab.whatsappHelp")}</p>
        </div>
        <div className="flex items-center gap-2">
          {channel && (
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
                    onClick={remove}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {t("common.delete")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              setDirty(true);
            }}
            disabled={saving}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="whatsapp-auth-mode">{t("channels.tab.whatsappAuthMode")}</Label>
        <p className="text-xs text-muted-foreground">{t("channels.tab.whatsappAuthModeHelp")}</p>
        {/* Native select: the mode drives which fields exist, and a plain
            element keeps this card testable without a portal-aware harness. */}
        <select
          id="whatsapp-auth-mode"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          value={mode}
          onChange={(e) => changeMode(e.target.value as AuthMode)}
        >
          <option value="authToken">{t("channels.tab.whatsappAuthModeToken")}</option>
          <option value="apiKey">{t("channels.tab.whatsappAuthModeApiKey")}</option>
        </select>
        {mode !== storedMode && (
          <p className="text-xs text-destructive">{t("channels.tab.whatsappModeSwitchWarning")}</p>
        )}
      </div>

      {fields.map((field) => {
        const stored = channel?.config?.[field.key];
        const placeholder = typeof stored === "string" ? stored : "";
        const isVisible = visible[field.key] ?? false;

        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`whatsapp-${field.key}`}>{t(field.labelKey)}</Label>
            <div className="relative">
              <Input
                id={`whatsapp-${field.key}`}
                type={field.sensitive && !isVisible ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) => updateValue(field.key, e.target.value)}
                placeholder={placeholder}
              />
              {field.sensitive && (
                <button
                  type="button"
                  onClick={() => setVisible((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {webhookUrl && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("channels.tab.whatsappWebhookUrl")}</Label>
          <p className="text-xs text-muted-foreground">{t("channels.tab.whatsappWebhookUrlHelp")}</p>
          <div className="flex items-center gap-2">
            <code className="block flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{webhookUrl}</code>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(webhookUrl);
                toast.success(t("channels.tab.whatsappUrlCopied"));
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="icon" variant="ghost">
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("channels.tab.whatsappRotateTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("channels.tab.whatsappRotateDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={rotate}>
                    {t("channels.tab.whatsappRotateSecret")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {dirty && (
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? t("common.saving") : t("common.saveSingle")}
          </Button>
        </div>
      )}
    </section>
  );
}
