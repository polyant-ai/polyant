// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { RequiredEnvEntry } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

export interface EnvVarDef {
  name: string;
  description: string;
  sensitive: boolean;
}

/** The skill's declared environment variables as the editor holds them: every field a string. */
export function toEnvVarDefs(requiredEnv: readonly RequiredEnvEntry[] | undefined): EnvVarDef[] {
  return (requiredEnv ?? []).map((e) => ({
    name: e.name,
    description: e.description ?? "",
    sensitive: e.sensitive,
  }));
}

/** What the API receives: rows without a name dropped, blank descriptions left out, `undefined` when none remain. */
export function toRequiredEnv(envVars: readonly EnvVarDef[]): RequiredEnvEntry[] | undefined {
  const valid = envVars
    .filter((e) => e.name.trim())
    .map((e) => ({
      name: e.name.trim(),
      ...(e.description.trim() ? { description: e.description.trim() } : {}),
      sensitive: e.sensitive,
    }));
  return valid.length > 0 ? valid : undefined;
}

/** The "required environment variables" field of a skill: a list of name, description and secret switch. */
export function EnvVarsEditor({
  value,
  onChange,
}: {
  value: EnvVarDef[];
  onChange: (next: EnvVarDef[]) => void;
}) {
  const { t } = useI18n();
  const update = (index: number, field: keyof EnvVarDef, next: string | boolean) =>
    onChange(value.map((v, i) => (i === index ? { ...v, [field]: next } : v)));

  return (
    <div className="space-y-2">
      <Label>{t("skills.form.requiredEnv")}</Label>
      {value.length > 0 && (
        <div className="space-y-3">
          {value.map((envVar, index) => (
            <div key={index} className="flex items-start gap-3 rounded-lg border p-3">
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-3">
                  <Input
                    value={envVar.name}
                    onChange={(e) => update(index, "name", e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                    placeholder={t("skills.form.envNamePlaceholder")}
                    className="font-mono text-sm"
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={envVar.sensitive}
                      onCheckedChange={(checked) => update(index, "sensitive", checked)}
                    />
                    <span className="text-xs text-muted-foreground">{t("skills.form.envSecret")}</span>
                  </div>
                </div>
                <Input
                  value={envVar.description}
                  onChange={(e) => update(index, "description", e.target.value)}
                  placeholder={t("skills.form.envDescPlaceholder")}
                  className="text-sm"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="shrink-0 mt-0.5"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...value, { name: "", description: "", sensitive: true }])}
        className="mt-2"
      >
        <Plus className="mr-2 size-4" />
        {t("skills.form.addVariable")}
      </Button>
    </div>
  );
}
