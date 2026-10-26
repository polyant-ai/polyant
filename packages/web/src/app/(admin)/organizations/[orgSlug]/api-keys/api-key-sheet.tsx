// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DrawerDeleteButton, ListDrawer } from "@/components/list-drawer";
import type { ManagementApiKey } from "@/lib/api";
import { useFormat } from "@/lib/use-format";
import { useI18n } from "@/lib/i18n/context";

/** Whether the key's expiry date has passed. */
export function isExpired(key: ManagementApiKey): boolean {
  return key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now();
}

/**
 * One API key, opened from its row: when it was made, last used and expires, and
 * the revocation, which asks first because everything using the key stops at once.
 */
export function ApiKeySheet({
  apiKey,
  busy,
  onRevoke,
  onClose,
}: {
  apiKey: ManagementApiKey | null;
  busy: boolean;
  /** Resolves true once the key was revoked. */
  onRevoke: (key: ManagementApiKey) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const format = useFormat();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <ListDrawer
        open={apiKey !== null}
        onOpenChange={(open) => !open && onClose()}
        title={apiKey?.name ?? ""}
        description={apiKey ? t("apiKeys.drawer.createdOn", { date: format.date(apiKey.createdAt) }) : ""}
        header={
          apiKey && isExpired(apiKey) ? (
            <div className="flex gap-2 pt-1">
              <Badge variant="secondary">{t("apiKeys.expired")}</Badge>
            </div>
          ) : undefined
        }
        destructive={
          apiKey && (
            <DrawerDeleteButton label={t("apiKeys.revoke.button")} disabled={busy} onClick={() => setConfirming(true)} />
          )
        }
      >
        {apiKey && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm">
            <dt className="text-muted-foreground">{t("apiKeys.table.created")}</dt>
            <dd>{format.date(apiKey.createdAt)}</dd>
            <dt className="text-muted-foreground">{t("apiKeys.table.lastUsed")}</dt>
            <dd>{apiKey.lastUsedAt ? format.relative(apiKey.lastUsedAt) : t("apiKeys.neverUsed")}</dd>
            <dt className="text-muted-foreground">{t("apiKeys.table.expires")}</dt>
            <dd>{apiKey.expiresAt === null ? t("apiKeys.noExpiry") : format.date(apiKey.expiresAt)}</dd>
          </dl>
        )}
      </ListDrawer>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("apiKeys.revoke.title")}
        description={apiKey ? t("apiKeys.revoke.description", { name: apiKey.name }) : undefined}
        confirmLabel={t("apiKeys.revoke.confirm")}
        pending={busy}
        onConfirm={async () => {
          if (!apiKey) return;
          const revoked = await onRevoke(apiKey);
          setConfirming(false);
          if (revoked) onClose();
        }}
      />
    </>
  );
}
