// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, getUserErrorMessage } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function CreateInstanceDialog({ open, onOpenChange, onCreated }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(toSlug(value));
  };

  const handleSlugChange = (value: string) => {
    setSlugEdited(true);
    setSlug(toSlug(value));
  };

  const isValid = name.trim().length > 0 && slug.length > 0;

  const handleCreate = async () => {
    setCreating(true);
    try {
      const { agent } = await api.instances.create({
        name: name.trim(),
        slug,
        description: description.trim() || undefined,
      });
      toast.success(t("instances.create.success"));
      resetForm();
      onCreated();
      router.push(`/agents/${agent.slug}`);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("instances.create.error")));
    } finally {
      setCreating(false);
    }
  };

  const resetForm = () => {
    setStep(1);
    setName("");
    setSlug("");
    setSlugEdited(false);
    setDescription("");
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm();
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("instances.create.title")}</DialogTitle>
              <DialogDescription>
                {t("instances.create.description")}
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">{t("instances.table.name")}</Label>
                <Input
                  id="name"
                  placeholder={t("instances.create.namePlaceholder")}
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="slug">{t("instances.table.slug")}</Label>
                <Input
                  id="slug"
                  placeholder={t("instances.create.slugPlaceholder")}
                  value={slug}
                  onChange={(e) => handleSlugChange(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("instances.create.slugHelp")}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">
                  {t("instances.table.description")}
                </Label>
                <Textarea
                  id="description"
                  placeholder={t("instances.create.descriptionPlaceholder")}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <Button onClick={() => setStep(2)} disabled={!isValid}>
                {t("common.continue")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("instances.create.reviewTitle")}</DialogTitle>
              <DialogDescription>
                {t("instances.create.reviewDescription")}
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 rounded-lg border bg-muted/50 p-4 space-y-2">
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">
                  {t("instances.table.name")}
                </span>
                <span className="text-sm font-medium">{name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-muted-foreground">
                  {t("instances.table.slug")}
                </span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {slug}
                </code>
              </div>
              {description && (
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">
                    {t("instances.table.description")}
                  </span>
                  <span className="text-sm max-w-[60%] text-right">
                    {description}
                  </span>
                </div>
              )}
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              {t("instances.create.reviewInfo")}
            </p>

            <div className="mt-6 flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>
                {t("common.back")}
              </Button>
              <Button onClick={handleCreate} disabled={creating}>
                {creating
                  ? t("instances.create.creating")
                  : t("instances.create.button")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
