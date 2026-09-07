// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/lib/i18n/context";
import { api, getUserErrorMessage, type AdminUser } from "@/lib/api";

interface Props {
  user: AdminUser | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

export function EditUserDialog({ user, onClose, onSaved }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      setIsPlatformAdmin(user.isPlatformAdmin);
    }
  }, [user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSubmitting(true);
    try {
      await api.users.update(user.id, {
        name: name.trim() || null,
        isPlatformAdmin,
      });
      toast.success(t("users.edit.saved"));
      await onSaved();
      onClose();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("users.edit.failed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("users.edit.title")}</DialogTitle>
          <DialogDescription>{user?.email}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="eu-name">{t("users.create.nameLabel")}</Label>
            <Input
              id="eu-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <Label htmlFor="eu-platform-admin">{t("users.role.platformAdmin")}</Label>
              <p className="text-sm text-muted-foreground">
                {t("users.edit.platformAdminHint")}
              </p>
            </div>
            <Switch
              id="eu-platform-admin"
              checked={isPlatformAdmin}
              onCheckedChange={setIsPlatformAdmin}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Annulla
            </Button>
            <Button type="submit" disabled={submitting}>
              {t("users.edit.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
