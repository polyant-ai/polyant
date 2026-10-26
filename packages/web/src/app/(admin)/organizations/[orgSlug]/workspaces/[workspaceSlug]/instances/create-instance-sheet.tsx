// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, getUserErrorMessage } from "@/lib/api";
import { ListDrawer } from "@/components/list-drawer";
import { useI18n } from "@/lib/i18n/context";
import { useTenantPaths } from "@/lib/tenant/use-tenant-paths";

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

export function CreateInstanceSheet({ open, onOpenChange, onCreated }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const paths = useTenantPaths();
  const [step, setStep] = useState<1 | 2>(1);
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
    if (!isValid) return;
    setCreating(true);
    try {
      const { instance } = await api.instances.create({
        name: name.trim(),
        slug,
        description: description.trim() || undefined,
      });
      toast.success(t("instances.create.success"));
      resetForm();
      onCreated();
      // The engine files the agent in the workspace named by the URL
      // (`request()` sends it as `X-Workspace-Slug`), so the pushed URL is the
      // workspace the agent is actually in.
      // Land on the prompts: what the agent says is the first thing to write for
      // a new one.
      router.push(paths.workspace(`/instances/${encodeURIComponent(instance.slug)}?tab=prompts`));
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

  const handleOpenChange = (next: boolean) => {
    if (!next) resetForm();
    onOpenChange(next);
  };

  const form = (
    <form
      id="create-instance-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (isValid) setStep(2);
      }}
      className="space-y-4"
    >
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
        <p className="text-xs text-muted-foreground">{t("instances.create.slugHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">{t("instances.table.description")}</Label>
        <Textarea
          id="description"
          placeholder={t("instances.create.descriptionPlaceholder")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>
    </form>
  );

  const review = (
    <>
      <div className="space-y-2 rounded-lg border bg-muted/50 p-4">
        <div className="flex justify-between">
          <span className="text-sm text-muted-foreground">{t("instances.table.name")}</span>
          <span className="text-sm font-medium">{name}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-muted-foreground">{t("instances.table.slug")}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{slug}</code>
        </div>
        {description && (
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">{t("instances.table.description")}</span>
            <span className="max-w-[60%] text-right text-sm">{description}</span>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("instances.create.reviewInfo")}</p>
    </>
  );

  return (
    <ListDrawer
      open={open}
      onOpenChange={handleOpenChange}
      title={step === 1 ? t("instances.create.title") : t("instances.create.reviewTitle")}
      description={step === 1 ? t("instances.create.description") : t("instances.create.reviewDescription")}
      actions={
        step === 2 && (
          <Button type="button" variant="ghost" onClick={() => setStep(1)}>
            {t("common.back")}
          </Button>
        )
      }
      primary={
        step === 1 ? (
          <Button type="submit" form="create-instance-form" disabled={!isValid}>
            {t("instances.create.next")}
          </Button>
        ) : (
          <Button type="button" onClick={handleCreate} disabled={creating}>
            {creating ? t("instances.create.creating") : t("instances.create.button")}
          </Button>
        )
      }
    >
      {step === 1 ? form : review}
    </ListDrawer>
  );
}
