// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
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

interface Props {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}

/**
 * The Web/API panel: the HTTP surface an external caller uses to talk to this
 * agent, and the one credential that gates it.
 *
 * It sits in the channel picker beside Telegram and Slack because that is what it
 * is to a reader — a way in. It is NOT a channel type: `CHANNEL_TYPES` has no
 * `web`, in this build or in enterprise. It is a panel over two things the agent
 * already has, `instances.auth_enabled` and the `auth_api_key` secret.
 *
 * Why it exists here at all: `auth_enabled` defaults to false, so a new agent's
 * api routes are open, and the agent's Status page correctly calls that `broken`
 * and sends the reader to this section. For a while the section had no control —
 * this panel was written, then dropped from OSS alongside the genuinely
 * enterprise `http` channel — so the product named a defect and offered no way to
 * fix it short of a hand-written PATCH.
 *
 * The switch governs EVERY api route that speaks to this agent — the
 * OpenAI-compatible completions endpoint, the native streaming endpoint, and the
 * CLI's alias of it — not just the one whose name someone happens to remember.
 * Turning it off opens all of them, so the copy says so rather than leaving an
 * admin to infer it from an endpoint list.
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
export function ChannelWebTab({ instance, onUpdate }: Props) {
  const { t } = useI18n();
  const [authEnabled, setAuthEnabled] = useState(instance.authEnabled);
  const [saving, setSaving] = useState(false);
  const apiKey = useInstanceSecret(instance.slug, SECRET_KEYS.AUTH);
  const savedMapping = instance.webContextFieldMapping ?? {};
  const [mappingRows, setMappingRows] = useState<MappingRow[]>(() => rowsFromMapping(savedMapping));
  const mapping = mappingFromRows(mappingRows);
  const mapsContext = Object.keys(mapping).length > 0;

  const isDirty = authEnabled !== instance.authEnabled || apiKey.dirty || !sameMapping(mapping, savedMapping);

  const handleSave = async () => {
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
      toast.success(t("settings.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  return (
    <div className="space-y-8">
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <Label className="text-base font-medium">{t("channels.tab.web")}</Label>
          <p className="text-sm text-muted-foreground">{t("channels.tab.webHelp")}</p>
        </div>

        <div className="flex items-center justify-between">
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
    </div>
  );
}
