// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
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
  const [envStatus, setEnvStatus] = useState<SkillEnvStatus[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showValues, setShowValues] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.skills
      .getEnv(slug, skillName)
      .then(({ env }) => {
        setEnvStatus(env);
        const initial: Record<string, string> = {};
        for (const e of env) {
          initial[e.key] = e.value;
        }
        setValues(initial);
        setShowValues({});
      })
      .catch((err) => {
        console.error("Failed to load env vars:", err);
        toast.error(t("skills.env.loadFailed"));
      })
      .finally(() => setLoading(false));
  }, [open, slug, skillName]);

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
      onOpenChange(false);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("general.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("skills.env.title", { name: skillName })}</DialogTitle>
          <DialogDescription>
            {t("skills.env.description")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
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
        )}

        <DialogFooter>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving ? t("common.saving") : t("common.saveSingle")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
