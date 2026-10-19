// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
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
import { OneTimeSecret } from "@/components/ui/one-time-secret";
import { useI18n } from "@/lib/i18n/context";
import { api, getUserErrorMessage, type AdminUser } from "@/lib/api";

interface Props {
  user: AdminUser | null;
  onClose: () => void;
}

export function ResetPasswordDialog({ user, onClose }: Props) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  function close() {
    setGenerated(null);
    onClose();
  }

  async function handleConfirm() {
    if (!user) return;
    setSubmitting(true);
    try {
      const res = await api.users.resetPassword(user.id);
      setGenerated(res.generatedPassword);
      toast.success(t("users.reset.success"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("users.reset.failed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("users.reset.title")}</DialogTitle>
          <DialogDescription>
            {generated ? t("users.reset.shownOnce") : t("users.reset.description")}
            {user && (
              <span className="mt-2 block font-medium">{user.email}</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {generated ? (
          <OneTimeSecret value={generated} copiedMessage={t("users.reset.copied")} />
        ) : null}

        <DialogFooter>
          {generated ? (
            <Button onClick={close}>OK</Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={close} disabled={submitting}>
                Annulla
              </Button>
              <Button onClick={handleConfirm} disabled={submitting}>
                {t("users.reset.confirm")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
