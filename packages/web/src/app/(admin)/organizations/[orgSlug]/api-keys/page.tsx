// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { api, getUserErrorMessage, isForbidden, type ManagementApiKey } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { PageHeader } from "@/components/layout/page-header";
import { LoadFailed } from "@/components/ui/load-failed";
import { useResource } from "@/hooks/use-resource";
import { PermissionRequired } from "@/components/layout/permission-required";
import { ListHead, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { useListView } from "@/components/use-list-view";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { ApiKeySheet, isExpired } from "./api-key-sheet";
import { CreateApiKeySheet } from "./create-api-key-sheet";

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
  const { data, error, loading, reload, mutate } = useResource(["api-keys", orgSlug], () => api.apiKeys.list(orgSlug));
  const keys = data?.keys ?? [];
  const forbidden = isForbidden(error);
  const [creating, setCreating] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openKeyId, setOpenKeyId] = useState<string | null>(null);

  const handleRevoke = async (key: ManagementApiKey): Promise<boolean> => {
    setBusyKeyId(key.id);
    try {
      await api.apiKeys.remove(orgSlug, key.id);
      mutate((current) => ({ ...current, keys: current.keys.filter((k) => k.id !== key.id) }));
      reload();
      toast.success(t("apiKeys.revoked"));
      return true;
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("apiKeys.revokeFailed")));
      return false;
    } finally {
      setBusyKeyId(null);
    }
  };

  const expiryText = (key: ManagementApiKey) =>
    key.expiresAt === null ? t("apiKeys.noExpiry") : isExpired(key) ? t("apiKeys.expired") : format.date(key.expiresAt);
  const visible = useListView(keys, search, (key) => [key.name, expiryText(key)], (key) => key.name);
  const openKey = openKeyId === null ? null : keys.find((key) => key.id === openKeyId) ?? null;

  const header = (
    <PageHeader
      title={t("apiKeys.title")}
      subtitle={t("apiKeys.subtitle")}
      actions={
        data !== undefined && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t("apiKeys.create.button")}
          </Button>
        )
      }
    />
  );

  if (loading && data === undefined) {
    return (
      <div>
        {header}
        <ListLoading />
      </div>
    );
  }

  if (error && !forbidden) {
    return (
      <div>
        {header}
        <LoadFailed message={t("apiKeys.loadFailed")} onRetry={reload} />
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
        <ListEmpty title={t("apiKeys.empty.title")} description={t("apiKeys.empty.description")} />
      ) : (
        <>
          <ListToolbar value={search} onChange={setSearch} className="mt-6" />
          {visible.length === 0 ? (
            <ListNoResults />
          ) : (
            <ListTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ListHead>{t("apiKeys.table.name")}</ListHead>
                  <ListHead className="w-36">{t("apiKeys.table.created")}</ListHead>
                  <ListHead className="w-36">{t("apiKeys.table.lastUsed")}</ListHead>
                  <ListHead className="w-36">{t("apiKeys.table.expires")}</ListHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((key) => (
                  <ListRow key={key.id} onOpen={() => setOpenKeyId(key.id)} selected={openKeyId === key.id}>
                    <ListNameCell name={key.name} onOpen={() => setOpenKeyId(key.id)} />
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
                  </ListRow>
                ))}
              </TableBody>
            </ListTable>
          )}
        </>
      )}

      <ApiKeySheet
        apiKey={openKey}
        busy={openKey !== null && busyKeyId === openKey.id}
        onRevoke={handleRevoke}
        onClose={() => setOpenKeyId(null)}
      />

      <CreateApiKeySheet
        orgSlug={orgSlug}
        open={creating}
        onOpenChange={setCreating}
        onCreated={reload}
      />
    </div>
  );
}
