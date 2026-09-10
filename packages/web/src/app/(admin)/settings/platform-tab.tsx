// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type PlatformSettingsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

/**
 * The installation's own policies, which had no surface because they had no
 * tier: they were `ANALYTICS_RETENTION_DAYS` and `SSE_MAX_CONNECTIONS_PER_USER`,
 * and changing either meant a redeploy.
 *
 * The fields are held as STRINGS and empty means "not set here". An empty field
 * shows the value in force as its PLACEHOLDER rather than being pre-filled with
 * it: pre-filling would make "unset" and "set to the same number" look
 * identical, and clearing a field back to the default would be impossible to
 * express.
 */
export function PlatformTab() {
  const { t } = useI18n();
  const [data, setData] = useState<PlatformSettingsResponse | null>(null);
  const [fields, setFields] = useState({ analyticsRetentionDays: "", sseMaxConnectionsPerUser: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await api.platform.settings();
    setData(response);
    setFields({
      analyticsRetentionDays: response.settings.analyticsRetentionDays?.toString() ?? "",
      sseMaxConnectionsPerUser: response.settings.sseMaxConnectionsPerUser?.toString() ?? "",
    });
  }, []);

  useEffect(() => {
    load().catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [load]);

  if (!data) return <Skeleton className="h-40 w-full" />;

  const dirty =
    fields.analyticsRetentionDays !== (data.settings.analyticsRetentionDays?.toString() ?? "") ||
    fields.sseMaxConnectionsPerUser !== (data.settings.sseMaxConnectionsPerUser?.toString() ?? "");

  /** Empty reaches the API as an explicit null, which is what clears a policy. */
  const asPatch = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await api.platform.updateSettings({
        analyticsRetentionDays: asPatch(fields.analyticsRetentionDays),
        sseMaxConnectionsPerUser: asPatch(fields.sseMaxConnectionsPerUser),
      });
      setData(response);
      toast.success(t("settings.platform.saved"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const rows = [
    {
      key: "analyticsRetentionDays" as const,
      id: "platform-analytics-retention",
      label: t("settings.platform.analyticsRetentionDays"),
      help: t("settings.platform.analyticsRetentionDaysHelp"),
    },
    {
      key: "sseMaxConnectionsPerUser" as const,
      id: "platform-sse-per-user",
      label: t("settings.platform.sseMaxConnectionsPerUser"),
      help: t("settings.platform.sseMaxConnectionsPerUserHelp"),
    },
  ];

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">{t("settings.platform.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("settings.platform.help")}</p>
      </div>

      {rows.map((row) => (
        <div key={row.key} className="space-y-1">
          <Label htmlFor={row.id} className="text-sm font-medium">
            {row.label}
          </Label>
          <Input
            id={row.id}
            type="number"
            min={1}
            value={fields[row.key]}
            placeholder={data.effective[row.key].toString()}
            onChange={(e) => setFields((prev) => ({ ...prev, [row.key]: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">{row.help}</p>
        </div>
      ))}

      <div>
        <Button onClick={save} disabled={!dirty || saving}>
          {t("settings.platform.save")}
        </Button>
      </div>
    </div>
  );
}
