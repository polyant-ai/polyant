// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SecretField } from "@/components/instance-secret/secret-field";
import { useInstanceSecret } from "@/components/instance-secret/use-instance-secret";
import { SECRET_KEYS } from "@/lib/provider-secrets";
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";
import { useDraft } from "./use-draft";

/**
 * LangSmith tracing, with its project and its key.
 *
 * Extracted from Generale, where it sat under the agent's name and description: it
 * traces what the agent DOES at runtime, which is the subject of the Parametri
 * page, not of the agent's identity.
 *
 * The key travels with the switch deliberately, like every key now: it is set
 * beside the thing that uses it, and its only use is the toggle three
 * centimetres above it.
 */
export function LangsmithCard({
  instance,
  onUpdate,
}: {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const { draft, set, isDirty: fieldsDirty } = useDraft({
    enabled: instance.langsmithEnabled,
    project: instance.langsmithProject ?? "",
  });
  const { enabled, project } = draft;
  const key = useInstanceSecret(instance.slug, SECRET_KEYS.LANGSMITH);

  // A pending key is a reason to enable Save too: without this the field would
  // accept a paste and offer no way to commit it.
  const isDirty = fieldsDirty || key.dirty;

  const handleSave = async () => {
    setSaving(true);
    try {
      // The secret first: if it fails, the flag that depends on it is not yet
      // saved, so the agent is never left tracing with no credential.
      await key.save();
      const { instance: updated } = await api.instances.update(instance.slug, {
        langsmithEnabled: enabled,
        langsmithProject: project || null,
      });
      onUpdate(updated);
      toast.success(t("general.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("general.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="agent-langsmith" className="text-base font-medium">
            {t("settings.tab.langsmith")}
          </Label>
          <p className="text-sm text-muted-foreground">{t("settings.tab.langsmithHelp")}</p>
        </div>
        <Switch id="agent-langsmith" checked={enabled} onCheckedChange={(v) => set("enabled", v)} />
      </div>

      {/* The project and the key appear only once tracing is on: they are its
          configuration, and showing them off reads as "fill these in first". */}
      {enabled && (
        <>
          <div className="space-y-2">
            <Label htmlFor="agent-langsmith-project">{t("settings.tab.langsmithProject")}</Label>
            <Input
              id="agent-langsmith-project"
              value={project}
              onChange={(e) => set("project", e.target.value)}
              placeholder={t("settings.tab.langsmithProjectPlaceholder")}
            />
          </div>

          <SecretField
            label={t("settings.tab.langsmithApiKey")}
            value={key.value}
            onChange={key.setValue}
            configured={key.configured}
            visible={key.visible}
            onToggleVisibility={key.toggleVisibility}
            placeholder={
              key.configured
                ? t("settings.tab.keyPlaceholderSet")
                : t("settings.tab.keyPlaceholder")
            }
            onRemove={key.configured ? key.remove : undefined}
          />
        </>
      )}
    </section>
  );
}
