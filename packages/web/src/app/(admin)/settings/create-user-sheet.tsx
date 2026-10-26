// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { OneTimeSecret } from "@/components/ui/one-time-secret";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ListDrawer } from "@/components/list-drawer";
import { useI18n } from "@/lib/i18n/context";
import { api, getUserErrorMessage } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void | Promise<void>;
}

/** The form that adds a user, in a drawer; a generated password is shown once, in place of the form. */
export function CreateUserSheet({ open, onOpenChange, onCreated }: Props) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  function reset() {
    setEmail("");
    setName("");
    setIsPlatformAdmin(false);
    setPassword("");
    setGenerated(null);
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.users.create({
        email: email.trim(),
        name: name.trim() || undefined,
        isPlatformAdmin,
        password: password.trim() || undefined,
      });
      toast.success(t("users.create.created"));
      await onCreated();
      if (res.generatedPassword) {
        setGenerated(res.generatedPassword);
      } else {
        close();
      }
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("users.create.failed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ListDrawer
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={t("users.create.title")}
      description={t("users.create.description")}
      primary={
        generated ? undefined : (
          <Button type="submit" form="create-user-form" disabled={submitting || !email.trim()}>
            {t("common.add")}
          </Button>
        )
      }
    >
      {generated ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("users.created.shownOnce")}</p>
          <OneTimeSecret value={generated} copiedMessage={t("users.reset.copied")} />
        </div>
      ) : (
        <form id="create-user-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cu-email">{t("users.create.emailLabel")}</Label>
            <Input id="cu-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cu-name">{t("users.create.nameLabel")}</Label>
            <Input id="cu-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div>
              <Label htmlFor="cu-platform-admin">{t("users.role.platformAdmin")}</Label>
              <p className="text-sm text-muted-foreground">{t("users.create.platformAdminHint")}</p>
            </div>
            <Switch id="cu-platform-admin" checked={isPlatformAdmin} onCheckedChange={setIsPlatformAdmin} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cu-password">{t("users.create.passwordLabel")}</Label>
            <Input
              id="cu-password"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">{t("users.create.passwordHint")}</p>
          </div>
        </form>
      )}
    </ListDrawer>
  );
}
