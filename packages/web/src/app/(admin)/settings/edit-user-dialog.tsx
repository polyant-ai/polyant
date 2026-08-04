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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/lib/i18n/context";
import { api, getUserErrorMessage, type AdminUser, type UserRole } from "@/lib/api";
import { PLATFORM_ADMIN_ROLE, normalizeUserRole } from "@/lib/user-role";

interface Props {
  user: AdminUser | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

export function EditUserDialog({ user, onClose, onSaved }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      // FOLDED, not taken verbatim. `GET /api/users` returns whatever is in the
      // column, and during the rename's shim window that can still be the legacy
      // spelling — for which this `<Select>` has no `<SelectItem>`, so the control
      // renders BLANK for an account that is in fact a platform admin. An admin
      // then edits the name and submits whatever blank resolves to.
      setRole(normalizeUserRole(user.role));
    }
  }, [user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSubmitting(true);
    try {
      await api.users.update(user.id, {
        name: name.trim() || null,
        role,
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="eu-role">{t("users.create.roleLabel")}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
              <SelectTrigger id="eu-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("users.role.user")}</SelectItem>
                <SelectItem value={PLATFORM_ADMIN_ROLE}>
                  {t("users.role.platformAdmin")}
                </SelectItem>
              </SelectContent>
            </Select>
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
