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
import { useI18n } from "@/lib/i18n/context";
import { api, getUserErrorMessage } from "@/lib/api";

interface Props {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void | Promise<void>;
}

/** Today as `YYYY-MM-DD` in local time, the earliest date the picker offers. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Issue a management API key, then show its token once.
 *
 * The engine returns the plaintext token in the creation response only, so the
 * dialog switches to a second state that holds it until closed. Closing drops it
 * from memory; there is no way back to it.
 */
export function CreateApiKeyDialog({ orgSlug, open, onOpenChange, onCreated }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  function close() {
    setName("");
    setExpiresOn("");
    setToken(null);
    onOpenChange(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.apiKeys.create(orgSlug, {
        name: name.trim(),
        // The picker gives a day; the key stays valid until that day ends, locally.
        ...(expiresOn ? { expiresAt: new Date(`${expiresOn}T23:59:59`).toISOString() } : {}),
      });
      setToken(res.token);
      await onCreated();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("apiKeys.create.failed")));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      toast.success(t("apiKeys.created.copied"));
    } catch {
      // The token stays on screen, selectable, when the clipboard is refused.
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        {token ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("apiKeys.created.title")}</DialogTitle>
              <DialogDescription>{t("apiKeys.created.shownOnce")}</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 font-mono text-sm">
              <span className="flex-1 break-all" data-testid="api-key-token">
                {token}
              </span>
              <Button
                size="icon"
                variant="ghost"
                onClick={copyToken}
                aria-label={t("apiKeys.created.copy")}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={close}>{t("apiKeys.created.done")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("apiKeys.create.title")}</DialogTitle>
              <DialogDescription>{t("apiKeys.create.description")}</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="api-key-name">{t("apiKeys.create.nameLabel")}</Label>
                <Input
                  id="api-key-name"
                  required
                  maxLength={255}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("apiKeys.create.nameHint")}</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="api-key-expiry">{t("apiKeys.create.expiryLabel")}</Label>
                <Input
                  id="api-key-expiry"
                  type="date"
                  min={today()}
                  value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t("apiKeys.create.expiryHint")}</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={submitting || !name.trim()}>
                  {t("apiKeys.create.submit")}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
