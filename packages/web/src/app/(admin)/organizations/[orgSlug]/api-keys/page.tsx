// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { api, getUserErrorMessage, isForbidden, type ManagementApiKey } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { PermissionRequired } from "@/components/layout/permission-required";
import { CreateApiKeyDialog } from "./create-api-key-dialog";

function isExpired(key: ManagementApiKey): boolean {
  return key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now();
}

/**
 * The organization's management API keys: the credential polyant-cli and other
 * automations send in `X-Polyant-Key`. Issuing and revoking need `org:write`,
 * which only an Owner holds; anyone else reaching the page gets the refusal
 * explained, as on Members.
 */
export default function ApiKeysPage() {
  const { t } = useI18n();
  const format = useFormat();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [keys, setKeys] = useState<ManagementApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      const { keys } = await api.apiKeys.list(orgSlug);
      setKeys(keys);
    } catch (err) {
      if (isForbidden(err)) setForbidden(true);
      else toast.error(getUserErrorMessage(err, t("apiKeys.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [t, orgSlug]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleRevoke = async (key: ManagementApiKey) => {
    setBusyKeyId(key.id);
    try {
      await api.apiKeys.remove(orgSlug, key.id);
      setKeys((prev) => prev.filter((k) => k.id !== key.id));
      toast.success(t("apiKeys.revoked"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("apiKeys.revokeFailed")));
    } finally {
      setBusyKeyId(null);
    }
  };

  const header = (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t("apiKeys.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("apiKeys.subtitle")}</p>
      </div>
      {!loading && !forbidden && (
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t("apiKeys.create.button")}
        </Button>
      )}
    </div>
  );

  if (loading) {
    return (
      <div>
        {header}
        <p className="mt-2 text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div>
        {header}
        <PermissionRequired description={t("permission.required.apiKeys")} />
      </div>
    );
  }

  return (
    <div>
      {header}

      {keys.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center">
          <p className="text-muted-foreground">{t("apiKeys.empty.title")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("apiKeys.empty.description")}</p>
        </div>
      ) : (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>{t("apiKeys.table.name")}</TableHead>
              <TableHead>{t("apiKeys.table.created")}</TableHead>
              <TableHead>{t("apiKeys.table.lastUsed")}</TableHead>
              <TableHead>{t("apiKeys.table.expires")}</TableHead>
              <TableHead className="w-[120px]">{t("apiKeys.table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell className="text-muted-foreground">{format.date(key.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {key.lastUsedAt ? format.relative(key.lastUsedAt) : t("apiKeys.neverUsed")}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {key.expiresAt === null ? (
                    t("apiKeys.noExpiry")
                  ) : isExpired(key) ? (
                    <Badge variant="secondary">{t("apiKeys.expired")}</Badge>
                  ) : (
                    format.date(key.expiresAt)
                  )}
                </TableCell>
                <TableCell>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" disabled={busyKeyId === key.id}>
                        {t("apiKeys.revoke.button")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("apiKeys.revoke.title")}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("apiKeys.revoke.description", { name: key.name })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => handleRevoke(key)}>
                          {t("apiKeys.revoke.confirm")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <CreateApiKeyDialog
        orgSlug={orgSlug}
        open={creating}
        onOpenChange={setCreating}
        onCreated={fetchKeys}
      />
    </div>
  );
}
