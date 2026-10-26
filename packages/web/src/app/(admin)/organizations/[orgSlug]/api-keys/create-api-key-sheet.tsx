// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { OneTimeSecret } from "@/components/ui/one-time-secret";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListDrawer } from "@/components/list-drawer";
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
 * drawer switches to a second state that holds it until closed. Closing drops it
 * from memory; there is no way back to it.
 */
export function CreateApiKeySheet({ orgSlug, open, onOpenChange, onCreated }: Props) {
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

  return (
    <ListDrawer
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={token ? t("apiKeys.created.title") : t("apiKeys.create.title")}
      description={token ? t("apiKeys.created.shownOnce") : t("apiKeys.create.description")}
      primary={
        token ? undefined : (
          <Button type="submit" form="create-api-key-form" disabled={submitting || !name.trim()}>
            {t("common.add")}
          </Button>
        )
      }
    >
      {token ? (
        <OneTimeSecret value={token} copiedMessage={t("apiKeys.created.copied")} copyLabel={t("apiKeys.created.copy")} />
      ) : (
        <form id="create-api-key-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
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
        </form>
      )}
    </ListDrawer>
  );
}
