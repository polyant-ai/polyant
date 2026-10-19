// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadFailed } from "@/components/ui/load-failed";
import { useResource } from "@/hooks/use-resource";
import { api, getUserErrorMessage, type SkillEnvStatus } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface SkillEnvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  skillName: string;
  onSaved: () => void;
}

export function SkillEnvDialog({
  open,
  onOpenChange,
  slug,
  skillName,
  onSaved,
}: SkillEnvDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("skills.env.title", { name: skillName })}</DialogTitle>
          <DialogDescription>
            {t("skills.env.description")}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while the dialog is open, so the variables are read when it opens. */}
        <SkillEnvBody slug={slug} skillName={skillName} onSaved={onSaved} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SkillEnvBody({
  slug,
  skillName,
  onSaved,
  onClose,
}: {
  slug: string;
  skillName: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { data, error, reload } = useResource(["skill-env", slug, skillName], () => api.skills.getEnv(slug, skillName));

  if (error) return <LoadFailed message={t("skills.env.loadFailed")} onRetry={reload} />;
  if (data === undefined) {
    return (
      <>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
        <DialogFooter>
          <Button disabled>{t("common.saveSingle")}</Button>
        </DialogFooter>
      </>
    );
  }
  return <SkillEnvForm slug={slug} skillName={skillName} envStatus={data.env} onSaved={onSaved} onClose={onClose} />;
}

function SkillEnvForm({
  slug,
  skillName,
  envStatus,
  onSaved,
  onClose,
}: {
  slug: string;
  skillName: string;
  envStatus: SkillEnvStatus[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(envStatus.map((e) => [e.key, e.value])),
  );
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const env = envStatus.map((e) => ({
        key: e.key,
        value: values[e.key] ?? "",
        sensitive: e.sensitive,
      }));
      await api.skills.setEnv(slug, skillName, env);
      toast.success(t("skills.env.saved"));
      onSaved();
      onClose();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("general.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="space-y-4 py-2">
          {envStatus.map((env) => (
            <div key={env.key} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor={`env-${env.key}`} className="font-mono text-sm">
                  {env.key}
                </Label>
                {env.configured && env.sensitive && !values[env.key] && (
                  <Check className="size-3.5 text-success" />
                )}
              </div>
              {env.description && (
                <p className="text-xs text-muted-foreground">{env.description}</p>
              )}
              <div className="relative">
                <Input
                  id={`env-${env.key}`}
                  type={env.sensitive && !showValues[env.key] ? "password" : "text"}
                  value={values[env.key] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [env.key]: e.target.value }))
                  }
                  placeholder={
                    env.sensitive && env.configured
                      ? t("skills.env.placeholderSet")
                      : t("skills.env.placeholderEnter")
                  }
                  className="pr-10 font-mono text-sm"
                />
                {env.sensitive && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-3"
                    onClick={() =>
                      setShowValues((prev) => ({
                        ...prev,
                        [env.key]: !prev[env.key],
                      }))
                    }
                  >
                    {showValues[env.key] ? (
                      <EyeOff className="size-4 text-muted-foreground" />
                    ) : (
                      <Eye className="size-4 text-muted-foreground" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {envStatus.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("skills.env.noVars")}
            </p>
          )}
        </div>

      <DialogFooter>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t("common.saving") : t("common.saveSingle")}
        </Button>
      </DialogFooter>
    </>
  );
}
