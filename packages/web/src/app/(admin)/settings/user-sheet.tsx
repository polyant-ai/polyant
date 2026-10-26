// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OneTimeSecret } from "@/components/ui/one-time-secret";
import { Switch } from "@/components/ui/switch";
import { DrawerDeleteButton, ListDrawer } from "@/components/list-drawer";
import { useI18n } from "@/lib/i18n/context";
import { api, getUserErrorMessage, type AdminUser } from "@/lib/api";

/**
 * One account, opened from its row: its name and Platform Admin flag to edit, the
 * password reset, and delete. Each action keeps the confirmation it had as a
 * dialog. The page gives it a `key` per account, so a generated password is
 * gone once the drawer closes and never shows on the next one.
 */
export function UserSheet({
  user,
  isSelf,
  onClose,
  onChanged,
}: {
  user: AdminUser | null;
  /** The signed-in account cannot delete itself. */
  isSelf: boolean;
  onClose: () => void;
  /** Called after the account was edited or deleted, so the list reads it again. */
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(user?.name ?? "");
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(user?.isPlatformAdmin ?? false);
  const [saving, setSaving] = useState(false);

  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    try {
      await api.users.update(user.id, { name: name.trim() || null, isPlatformAdmin });
      toast.success(t("users.edit.saved"));
      await onChanged();
      onClose();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("users.edit.failed")));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!user) return;
    setResetting(true);
    try {
      const res = await api.users.resetPassword(user.id);
      setGenerated(res.generatedPassword);
      setConfirmReset(false);
      toast.success(t("users.reset.success"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("users.reset.failed")));
    } finally {
      setResetting(false);
    }
  }

  async function handleDelete() {
    if (!user) return;
    setDeleting(true);
    try {
      await api.users.delete(user.id);
      toast.success(t("users.delete.deleted"));
      setConfirmDelete(false);
      await onChanged();
      onClose();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("users.delete.failed")));
    } finally {
      setDeleting(false);
    }
  }

  const passwordState = !user?.hasPassword
    ? t("users.password.notSet")
    : user.mustChangePassword
      ? t("users.password.mustChange")
      : t("users.password.set");

  return (
    <>
      <ListDrawer
        open={user !== null}
        onOpenChange={(open) => !open && onClose()}
        title={user ? user.name ?? user.email : ""}
        description={user ? (user.name ? user.email : user.isPlatformAdmin ? t("users.role.platformAdmin") : t("users.role.user")) : ""}
        destructive={user && <DrawerDeleteButton disabled={isSelf} onClick={() => setConfirmDelete(true)} />}
        primary={
          user && (
            <Button type="submit" form="edit-user-form" disabled={saving}>
              {t("users.edit.submit")}
            </Button>
          )
        }
      >
        {user && (
          <>
            <form id="edit-user-form" onSubmit={handleSave} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eu-name">{t("users.create.nameLabel")}</Label>
                <Input id="eu-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div>
                  <Label htmlFor="eu-platform-admin">{t("users.role.platformAdmin")}</Label>
                  <p className="text-sm text-muted-foreground">{t("users.edit.platformAdminHint")}</p>
                </div>
                <Switch id="eu-platform-admin" checked={isPlatformAdmin} onCheckedChange={setIsPlatformAdmin} />
              </div>
            </form>

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-medium">{t("users.table.password")}</h3>
                  <p className="text-sm text-muted-foreground">{passwordState}</p>
                </div>
                <Button type="button" variant="outline" onClick={() => setConfirmReset(true)}>
                  <KeyRound className="size-4" aria-hidden />
                  {t("users.action.resetPassword")}
                </Button>
              </div>
              {generated && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{t("users.reset.shownOnce")}</p>
                  <OneTimeSecret value={generated} copiedMessage={t("users.reset.copied")} />
                </div>
              )}
            </section>
          </>
        )}
      </ListDrawer>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t("users.reset.title")}
        description={
          <>
            {t("users.reset.description")}
            {user && <span className="mt-2 block font-medium">{user.email}</span>}
          </>
        }
        confirmLabel={t("users.reset.confirm")}
        destructive={false}
        onConfirm={handleReset}
        pending={resetting}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("users.delete.title")}
        description={
          <>
            {t("users.delete.description")}
            {user && <span className="mt-2 block font-medium">{user.email}</span>}
          </>
        }
        confirmLabel={t("users.delete.confirm")}
        onConfirm={handleDelete}
        pending={deleting}
      />
    </>
  );
}
