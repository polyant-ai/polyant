// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, getUserErrorMessage, type RequiredEnvEntry } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { EnvVarsEditor, toEnvVarDefs, toRequiredEnv, type EnvVarDef } from "./env-vars-editor";

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
  const [envVars, setEnvVars] = useState<EnvVarDef[]>(toEnvVarDefs(initialData?.requiredEnv));
  const [content, setContent] = useState(initialData?.content ?? "");

  const isValid =
    mode === "edit" || (name.trim().length > 0 && content.trim().length > 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      const reqEnv = toRequiredEnv(envVars);

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

        <EnvVarsEditor value={envVars} onChange={setEnvVars} />

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
