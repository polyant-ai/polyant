// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SecretField } from "@/components/instance-secret/secret-field";
import { ReadableField } from "@/components/instance-secret/secret-spec-field";
import { useInstanceSecret } from "@/components/instance-secret/use-instance-secret";
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { usePageSaveAction } from "./page-actions-context";

/**
 * Attachment storage: the switch that keeps the files users send, and the
 * agent's bucket they go to.
 *
 * The bucket and its keys used to be set only on the `fileUpload` tool, whose
 * declared secrets the engine's attachment persistence reused. That tool is a
 * plugin now, so the fields live here, beside the one switch in core that
 * needs them. The keys are the engine's (`attachments/agent-s3.ts`): the
 * bucket, its region, and both static access keys.
 */
const KEYS = {
  bucket: "s3_bucket_name",
  region: "aws_region",
  accessKeyId: "aws_access_key_id",
  secretAccessKey: "aws_secret_access_key",
} as const;

export function AttachmentStorageCard({
  instance,
  onUpdate,
}: {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(instance.attachmentStorageEnabled ?? false);
  const bucket = useInstanceSecret(instance.slug, KEYS.bucket);
  const region = useInstanceSecret(instance.slug, KEYS.region);
  const accessKeyId = useInstanceSecret(instance.slug, KEYS.accessKeyId);
  const secretAccessKey = useInstanceSecret(instance.slug, KEYS.secretAccessKey);
  const fields = [bucket, region, accessKeyId, secretAccessKey];

  useEffect(() => {
    setEnabled(instance.attachmentStorageEnabled ?? false);
  }, [instance.attachmentStorageEnabled]);

  const flagDirty = enabled !== (instance.attachmentStorageEnabled ?? false);
  const isDirty = flagDirty || fields.some((f) => f.dirty);

  const handleSave = async () => {
    setSaving(true);
    try {
      // The bucket first: if a key fails to save, the switch that depends on it
      // is not yet on, so the agent never stores into a half-configured bucket.
      for (const field of fields) await field.save();
      if (flagDirty) {
        const { instance: updated } = await api.instances.update(instance.slug, {
          attachmentStorageEnabled: enabled,
        });
        onUpdate(updated);
      }
      toast.success(t("settings.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  const placeholderSet = t("settings.tab.keyPlaceholderSet");

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="agent-attachment-storage" className="text-base font-medium">
            {t("settings.tab.attachmentStorage")}
          </Label>
          <p className="text-sm text-muted-foreground">{t("settings.tab.attachmentStorageHelp")}</p>
        </div>
        <Switch id="agent-attachment-storage" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* The bucket appears once storage is on: it is the switch's configuration,
          and showing it off reads as "fill these in first". */}
      {enabled && (
        <>
          <p className="text-xs text-muted-foreground">{t("settings.tab.attachmentStorageBucketHelp")}</p>
          <ReadableField
            id="agent-attachment-bucket"
            label={t("settings.tab.attachmentStorageBucket")}
            value={bucket.value}
            onChange={bucket.setValue}
            configured={bucket.configured}
            placeholder={bucket.configured ? placeholderSet : ""}
            onRemove={bucket.configured ? bucket.remove : undefined}
          />
          <ReadableField
            id="agent-attachment-region"
            label={t("settings.tab.awsRegion")}
            value={region.value}
            onChange={region.setValue}
            configured={region.configured}
            placeholder={region.configured ? placeholderSet : t("settings.tab.awsRegionPlaceholder")}
            onRemove={region.configured ? region.remove : undefined}
          />
          <SecretField
            label={t("settings.tab.awsAccessKeyId")}
            value={accessKeyId.value}
            onChange={accessKeyId.setValue}
            configured={accessKeyId.configured}
            visible={accessKeyId.visible}
            onToggleVisibility={accessKeyId.toggleVisibility}
            placeholder={accessKeyId.configured ? placeholderSet : t("settings.tab.awsAccessKeyIdPlaceholder")}
            onRemove={accessKeyId.configured ? accessKeyId.remove : undefined}
          />
          <SecretField
            label={t("settings.tab.awsSecretAccessKey")}
            value={secretAccessKey.value}
            onChange={secretAccessKey.setValue}
            configured={secretAccessKey.configured}
            visible={secretAccessKey.visible}
            onToggleVisibility={secretAccessKey.toggleVisibility}
            placeholder={secretAccessKey.configured ? placeholderSet : ""}
            onRemove={secretAccessKey.configured ? secretAccessKey.remove : undefined}
          />
        </>
      )}
    </section>
  );
}
