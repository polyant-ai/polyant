// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, getUserErrorMessage, type RequiredEnvEntry } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface EnvVarDef {
  name: string;
  description: string;
  sensitive: boolean;
}

interface SkillFormProps {
  mode: "create" | "edit";
  initialData?: {
    name: string;
    description: string;
    requiredEnv?: RequiredEnvEntry[];
    content: string;
  };
}

export function SkillForm({ mode, initialData }: SkillFormProps) {
  const router = useRouter();
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [envVars, setEnvVars] = useState<EnvVarDef[]>(
    initialData?.requiredEnv?.map((e) => ({
      name: e.name,
      description: e.description ?? "",
      sensitive: e.sensitive,
    })) ?? [],
  );
  const [content, setContent] = useState(initialData?.content ?? "");

  const isValid =
    mode === "edit" || (name.trim().length > 0 && content.trim().length > 0);

  const addEnvVar = () => {
    setEnvVars((prev) => [...prev, { name: "", description: "", sensitive: true }]);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  };

  const updateEnvVar = (index: number, field: keyof EnvVarDef, value: string | boolean) => {
    setEnvVars((prev) =>
      prev.map((v, i) => (i === index ? { ...v, [field]: value } : v)),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const validEnvVars = envVars
        .filter((e) => e.name.trim())
        .map((e) => ({
          name: e.name.trim(),
          ...(e.description.trim() ? { description: e.description.trim() } : {}),
          sensitive: e.sensitive,
        }));

      const reqEnv = validEnvVars.length > 0 ? validEnvVars : undefined;

      if (mode === "create") {
        await api.skillLibrary.create({
          name,
          description,
          content,
          requiredEnv: reqEnv,
        });
      } else {
        await api.skillLibrary.update(initialData!.name, {
          description,
          content,
          requiredEnv: reqEnv,
        });
      }

      router.push("/skills");
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.form.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">
          {mode === "create" ? t("skills.form.newTitle") : initialData?.name}
        </h1>
        <Button onClick={handleSave} disabled={saving || !isValid}>
          {saving ? t("common.saving") : t("common.saveSingle")}
        </Button>
      </div>

      <div className="mt-6 space-y-6 max-w-2xl">
        <div className="space-y-2">
          <Label htmlFor="name">{t("skills.form.name")}</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) =>
              setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
            }
            placeholder={t("skills.form.namePlaceholder")}
            readOnly={mode === "edit"}
            className={mode === "edit" ? "opacity-60" : ""}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">{t("skills.form.description")}</Label>
          <Input
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("skills.form.descriptionPlaceholder")}
          />
        </div>

        <div className="space-y-2">
          <Label>{t("skills.form.requiredEnv")}</Label>
          {envVars.length > 0 && (
            <div className="space-y-3">
              {envVars.map((envVar, index) => (
                <div
                  key={index}
                  className="flex items-start gap-3 rounded-lg border p-3"
                >
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-3">
                      <Input
                        value={envVar.name}
                        onChange={(e) =>
                          updateEnvVar(
                            index,
                            "name",
                            e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
                          )
                        }
                        placeholder={t("skills.form.envNamePlaceholder")}
                        className="font-mono text-sm"
                      />
                      <div className="flex items-center gap-2 shrink-0">
                        <Switch
                          checked={envVar.sensitive}
                          onCheckedChange={(checked) =>
                            updateEnvVar(index, "sensitive", checked)
                          }
                        />
                        <span className="text-xs text-muted-foreground">
                          {t("skills.form.envSecret")}
                        </span>
                      </div>
                    </div>
                    <Input
                      value={envVar.description}
                      onChange={(e) =>
                        updateEnvVar(index, "description", e.target.value)
                      }
                      placeholder={t("skills.form.envDescPlaceholder")}
                      className="text-sm"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeEnvVar(index)}
                    className="shrink-0 mt-0.5"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={addEnvVar} className="mt-2">
            <Plus className="mr-2 size-4" />
            {t("skills.form.addVariable")}
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="content">{t("skills.form.content")}</Label>
          <Textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t("skills.form.contentPlaceholder")}
            className="min-h-[400px] font-mono text-sm"
          />
        </div>
      </div>
    </div>
  );
}
