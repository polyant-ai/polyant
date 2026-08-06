// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";

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
import { api, getUserErrorMessage, type UserRole } from "@/lib/api";
import { PLATFORM_ADMIN_ROLE } from "@/lib/user-role";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void | Promise<void>;
}

export function CreateUserDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  function reset() {
    setEmail("");
    setName("");
    setRole("user");
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
        role,
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

  async function copyGenerated() {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated);
      toast.success(t("users.reset.copied"));
    } catch {
      // ignore
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("users.create.title")}</DialogTitle>
          <DialogDescription>{t("users.create.description")}</DialogDescription>
        </DialogHeader>

        {generated ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t("users.created.shownOnce")}
            </p>
            <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 font-mono text-sm">
              <span className="flex-1 break-all">{generated}</span>
              <Button size="icon" variant="ghost" onClick={copyGenerated}>
                <Copy className="size-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={close}>OK</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cu-email">{t("users.create.emailLabel")}</Label>
              <Input
                id="cu-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cu-name">{t("users.create.nameLabel")}</Label>
              <Input
                id="cu-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cu-role">{t("users.create.roleLabel")}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
                <SelectTrigger id="cu-role">
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cu-password">{t("users.create.passwordLabel")}</Label>
              <Input
                id="cu-password"
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                {t("users.create.passwordHint")}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Annulla
              </Button>
              <Button type="submit" disabled={submitting || !email.trim()}>
                {t("users.create.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
