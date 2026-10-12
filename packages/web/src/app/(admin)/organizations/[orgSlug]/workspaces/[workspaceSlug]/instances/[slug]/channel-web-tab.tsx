// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { SecretField } from "@/components/instance-secret/secret-field";
import { useInstanceSecret } from "@/components/instance-secret/use-instance-secret";
import { SECRET_KEYS } from "@/lib/provider-secrets";
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";
import { FieldMappingEditor, mappingFromRows, type MappingRow, rowsFromMapping } from "./field-mapping-editor";

/** Same mapping regardless of key order: the engine stores an object, the editor a list. */
function sameMapping(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

/** 256 random bits as hex: long enough to be unguessable, and safe to paste in a header. */
function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Props {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
  /** Called with the Web channel's state once it is known or has been saved, so the channel picker's dot follows it. */
  onWebEnabledChange?: (enabled: boolean) => void;
}

/**
 * The Web channel: the agent's public HTTP endpoints (the OpenAI-compatible
 * completions endpoint, the native streaming endpoint and the CLI's alias) and
 * the one credential that gates them.
 *
 * It is a channel like the others: an `instance_channels` row of type `web`
 * whose `enabled` flag decides whether the endpoints answer at all, and a new
 * agent starts with it off. Authentication stays on the agent
 * (`instances.auth_enabled` and the `auth_api_key` secret) because A2A shares
 * it. The Playground does not use these endpoints, so it works with Web off.
 *
 * Authentication is on by default and turning it off asks the reader to accept
 * the risk on screen first. The switch governs EVERY route of the channel, so the
 * copy says so rather than leaving an admin to infer it from an endpoint list.
 *
 * The key is agent-only: `auth_api_key` is deliberately absent from the
 * organization-shareable set, because one org-level key would authenticate every
 * agent in the organization.
 *
 * The context fields map a request's `context` onto the conversation state
 * before the turn. Once a field is mapped, every web turn needs the key even
 * when the switch is off (later turns read the state context wrote), so the key
 * field shows as soon as a field is mapped.
 */
export function ChannelWebTab({ instance, onUpdate, onWebEnabledChange }: Props) {
  const { t } = useI18n();
  const [webEnabled, setWebEnabled] = useState(false);
  const [savedWebEnabled, setSavedWebEnabled] = useState(false);
  const [webLoaded, setWebLoaded] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(instance.authEnabled);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const apiKey = useInstanceSecret(instance.slug, SECRET_KEYS.AUTH);
  const savedMapping = instance.webContextFieldMapping ?? {};
  const [mappingRows, setMappingRows] = useState<MappingRow[]>(() => rowsFromMapping(savedMapping));
  const mapping = mappingFromRows(mappingRows);
  const mapsContext = Object.keys(mapping).length > 0;

  useEffect(() => {
    let active = true;
    api.channels
      .list(instance.slug)
      .then((res) => {
        if (!active) return;
        // No row means off.
        const on = res.channels.find((c) => c.channelType === "web")?.enabled ?? false;
        setWebEnabled(on);
        setSavedWebEnabled(on);
        setWebLoaded(true);
        onWebEnabledChange?.(on);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.slug]);

  const isDirty =
    (webLoaded && webEnabled !== savedWebEnabled) ||
    authEnabled !== instance.authEnabled ||
    apiKey.dirty ||
    !sameMapping(mapping, savedMapping);

  const handleSave = async (riskAccepted = false) => {
    // Opening the agent is allowed, but never silently: the reader accepts the
    // risk on screen first. A notice, not a permission gate.
    if (instance.authEnabled && !authEnabled && !riskAccepted) {
      setConfirmOpen(true);
      return;
    }
    // Turning auth ON with no key — neither stored nor typed — saves a state the
    // engine answers with 401 "Auth enabled but no API key configured" to every
    // `/v1` and `/chat/stream` caller. `apiKey.save()` is a no-op when nothing
    // was typed, so nothing else stops it.
    if (authEnabled && !apiKey.configured && !apiKey.value.trim()) {
      toast.error(t("channels.tab.webAuthKeyRequired"));
      return;
    }
    // Context fields with no key would save a mapping the engine refuses to use:
    // every request with context answers 401 until a key exists.
    if (mapsContext && !apiKey.configured && !apiKey.value.trim()) {
      toast.error(t("channels.tab.webContextKeyRequired"));
      return;
    }

    setSaving(true);
    try {
      // The key first: a failure here must never leave the switch on with nothing
      // behind it, which would refuse every caller.
      await apiKey.save();
      const { instance: updated } = await api.instances.update(instance.slug, {
        authEnabled,
        webContextFieldMapping: mapping,
      });
      setMappingRows(rowsFromMapping(updated.webContextFieldMapping ?? mapping));
      onUpdate(updated);
      // The channel last: with authentication and the key in place first, the
      // engine accepts the switch, and a failure here leaves Web as it was.
      if (webLoaded && webEnabled !== savedWebEnabled) {
        await api.channels.set(instance.slug, "web", {}, webEnabled);
        setSavedWebEnabled(webEnabled);
        onWebEnabledChange?.(webEnabled);
      }
      toast.success(t("settings.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: () => handleSave() });

  return (
    <div className="space-y-8">
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("channels.tab.web")}</Label>
          <p className="text-sm text-muted-foreground">{t("channels.tab.webHelp")}</p>
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="web-channel-enabled">{t("channels.tab.webEnabled")}</Label>
            <p className="text-sm text-muted-foreground">{t("channels.tab.webEnabledHelp")}</p>
          </div>
          <Switch
            id="web-channel-enabled"
            checked={webEnabled}
            disabled={!webLoaded}
            onCheckedChange={setWebEnabled}
          />
        </div>

        <div className="flex items-center justify-between" data-tour="web-auth">
          <div className="space-y-0.5">
            <Label htmlFor="agent-auth-enabled">{t("settings.tab.authEnabled")}</Label>
            <p className="text-sm text-muted-foreground">{t("channels.tab.webAuthHelp")}</p>
          </div>
          <Switch
            id="agent-auth-enabled"
            checked={authEnabled}
            onCheckedChange={setAuthEnabled}
          />
        </div>

        {(authEnabled || mapsContext) && (
          <SecretField
            label={t("settings.tab.authApiKey")}
            value={apiKey.value}
            onChange={apiKey.setValue}
            configured={apiKey.configured}
            visible={apiKey.visible}
            onToggleVisibility={apiKey.toggleVisibility}
            placeholder={
              apiKey.configured
                ? t("settings.tab.keyPlaceholderSet")
                : t("settings.tab.authKeyPlaceholder")
            }
            onRemove={apiKey.configured ? apiKey.remove : undefined}
          />
        )}
        {(authEnabled || mapsContext) && !apiKey.loading && (
          <div className="space-y-2">
            {!apiKey.configured && (
              <p className="text-sm text-muted-foreground">{t("channels.tab.webKeyNeeded")}</p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                apiKey.setValue(generateApiKey());
                if (!apiKey.visible) apiKey.toggleVisibility();
              }}
            >
              {t(apiKey.configured ? "channels.tab.webKeyRegenerate" : "channels.tab.webKeyGenerate")}
            </Button>
            {apiKey.value && (
              <p className="text-xs text-muted-foreground">{t("channels.tab.webKeyGeneratedHint")}</p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2 rounded-lg border p-4">
        <Label className="text-base font-medium">{t("channels.tab.webContextMapping")}</Label>
        <p className="text-sm text-muted-foreground">{t("channels.tab.webContextMappingHelp")}</p>
        <FieldMappingEditor
          rows={mappingRows}
          onChange={setMappingRows}
          pathPlaceholder={t("channels.tab.webContextMappingPath")}
        />
      </section>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("channels.tab.webAuthOffTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("channels.tab.webAuthOffDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                void handleSave(true);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("channels.tab.webAuthOffAccept")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
