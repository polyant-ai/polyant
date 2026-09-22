// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  api,
  PLATFORM_SETTING_NUMBERS,
  type PlatformSettings,
  type PlatformSettingsResponse,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

/** Every policy as the form holds it: a string, because empty means "not set here". */
type FormFields = Record<keyof PlatformSettings, string>;

const EMPTY_FIELDS: FormFields = {
  ...(Object.fromEntries(PLATFORM_SETTING_NUMBERS.map((key) => [key, ""])) as Omit<FormFields, "baseUrl">),
  baseUrl: "",
};

/** The order and grouping the page reads in, which is not the order the API returns. */
const GROUPS: ReadonlyArray<{ title: TranslationKey; keys: ReadonlyArray<keyof PlatformSettings> }> = [
  { title: "settings.platform.groupGeneral", keys: ["baseUrl", "analyticsRetentionDays"] },
  {
    title: "settings.platform.groupLimits",
    keys: ["sseMaxConnections", "sseMaxConnectionsPerUser", "throttleTtlMs", "throttleLimit"],
  },
  {
    title: "settings.platform.groupTimeouts",
    keys: [
      "agentCallTimeoutMs",
      "mcpConnectTimeoutMs",
      "schedulerOrphanGraceMs",
      "schedulerDefaultMaxRunMs",
    ],
  },
];

const ALL_KEYS = GROUPS.flatMap((group) => group.keys);

function storedAsText(settings: PlatformSettings, key: keyof PlatformSettings): string {
  const value = settings[key];
  return value === null ? "" : String(value);
}

/**
 * The installation's own policies, which had no surface because they had no
 * tier: they were environment variables, and changing any of them meant a
 * redeploy.
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
  const [fields, setFields] = useState<FormFields>(EMPTY_FIELDS);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await api.platform.settings();
    setData(response);
    setFields(
      Object.fromEntries(ALL_KEYS.map((key) => [key, storedAsText(response.settings, key)])) as FormFields,
    );
  }, []);

  useEffect(() => {
    load().catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
  }, [load]);

  if (!data) return <Skeleton className="h-40 w-full" />;

  const settings = data.settings;
  const dirty = ALL_KEYS.some((key) => fields[key] !== storedAsText(settings, key));

  const save = async () => {
    setSaving(true);
    try {
      // Empty reaches the API as an explicit null, which is what clears a policy.
      const numbers = Object.fromEntries(
        PLATFORM_SETTING_NUMBERS.map((key) => {
          const raw = fields[key].trim();
          return [key, raw ? Number(raw) : null];
        }),
      ) as { [K in (typeof PLATFORM_SETTING_NUMBERS)[number]]: number | null };
      const response = await api.platform.updateSettings({
        ...numbers,
        baseUrl: fields.baseUrl.trim() || null,
      });
      setData(response);
      setFields(
        Object.fromEntries(ALL_KEYS.map((key) => [key, storedAsText(response.settings, key)])) as FormFields,
      );
      toast.success(t("settings.platform.saved"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-xl flex-col gap-8">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">{t("settings.platform.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("settings.platform.help")}</p>
      </div>

      {GROUPS.map((group) => (
        <div key={group.title} className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">{t(group.title)}</h3>
          {group.keys.map((key) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`platform-${key}`} className="text-sm font-medium">
                {t(`settings.platform.${key}` as TranslationKey)}
              </Label>
              <Input
                id={`platform-${key}`}
                type={key === "baseUrl" ? "url" : "number"}
                {...(key === "baseUrl" ? {} : { min: 1 })}
                value={fields[key]}
                placeholder={String(data.effective[key])}
                onChange={(e) => setFields((prev) => ({ ...prev, [key]: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                {t(`settings.platform.${key}Help` as TranslationKey)}
              </p>
            </div>
          ))}
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
