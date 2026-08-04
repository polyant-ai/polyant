// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { IconUpload } from "@/components/icon-upload";
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

interface Props {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}

export function GeneralTab({ instance, onUpdate }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState(instance.name);
  const [description, setDescription] = useState(instance.description ?? "");
  const [status, setStatus] = useState(instance.status);
  const [saving, setSaving] = useState(false);
  const [icon, setIcon] = useState(instance.icon);
  // Memory moved here from the model settings: whether the agent remembers is
  // part of what it IS, not of which model runs it. Rides the tab's existing
  // save rather than writing on change, because it sits beside fields that do.
  const [memoryEnabled, setMemoryEnabled] = useState(instance.memoryEnabled);

  const handleIconUpload = useCallback(async (dataUri: string) => {
    try {
      const { instance: updated } = await api.instances.setIcon(instance.slug, dataUri);
      setIcon(updated.icon);
      onUpdate(updated);
      toast.success(t("general.iconUploaded"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("general.iconUploadFailed")));
    }
  }, [instance.slug, onUpdate, t]);

  const handleIconRemove = useCallback(async () => {
    try {
      const { instance: updated } = await api.instances.deleteIcon(instance.slug);
      setIcon(updated.icon);
      onUpdate(updated);
      toast.success(t("general.iconRemoved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("general.iconUploadFailed")));
    }
  }, [instance.slug, onUpdate, t]);

  const isDirty =
    name !== instance.name ||
    description !== (instance.description ?? "") ||
    status !== instance.status ||
    memoryEnabled !== instance.memoryEnabled;

  const handleSave = async () => {
    setSaving(true);
    try {
      const { instance: updated } = await api.instances.update(instance.slug, {
        name,
        description: description || null,
        status,
        memoryEnabled,
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
    <div className="max-w-2xl space-y-6">
      <IconUpload
        icon={icon}
        onUpload={handleIconUpload}
        onRemove={handleIconRemove}
      />

      <div className="space-y-2">
        <Label htmlFor="gen-name">{t("general.name")}</Label>
        <Input
          id="gen-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="gen-slug">{t("general.slug")}</Label>
        <Input id="gen-slug" value={instance.slug} disabled />
        <p className="text-xs text-muted-foreground">
          {t("general.slugHelp")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="gen-desc">{t("general.description")}</Label>
        <Textarea
          id="gen-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <Label htmlFor="agent-status">{t("general.status")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("general.statusHelp")}
          </p>
        </div>
        <Switch
          id="agent-status"
          checked={status === "active"}
          onCheckedChange={(checked) => setStatus(checked ? "active" : "inactive")}
        />
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="agent-memory" className="text-base font-medium">
              {t("settings.tab.memory")}
            </Label>
            <p className="text-sm text-muted-foreground">{t("settings.tab.memoryHelp")}</p>
          </div>
          <Switch id="agent-memory" checked={memoryEnabled} onCheckedChange={setMemoryEnabled} />
        </div>

        {/* Came along with the switch: the engine already reports this on the
            instance, and it keys off the EMBEDDER (openai|bedrock), which is
            independent of the chat provider (#150) and configured under Modello. */}
        {memoryEnabled && instance.memory?.needsOpenAIKey && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-sm">
              {t(
                (instance.embeddingProvider as string | undefined) === "bedrock"
                  ? "memory.banner.bedrockNeedsAws"
                  : "memory.banner.openaiNeedsKey",
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
