// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Loader2, Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadFailed } from "@/components/ui/load-failed";
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ListControlCell, ListHead, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { api, getUserErrorMessage, type McpServer } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useFormat } from "@/lib/use-format";
import { useI18n } from "@/lib/i18n/context";
import { McpServerDialog } from "./mcp-server-dialog";
import { SectionActions } from "./section-actions";

interface Props {
  slug: string;
}

export function McpServersTab({ slug }: Props) {
  const { t } = useI18n();
  const { data, error, loading, reload } = useResource(["mcp-servers", slug], () => api.mcpServers.list(slug));
  const servers = data ?? [];
  const [dialogOpen, setDialogOpen] = useState(false);
  // Changes for each opening, so the dialog's form starts afresh.
  const [dialogKey, setDialogKey] = useState(0);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  // The server whose shared account is being connected in another tab. The
  // provider redirects there, not here, so the list is read again when this
  // tab regains focus.
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    if (!connecting) return;
    const onFocus = () => {
      setConnecting(null);
      reload();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [connecting, reload]);

  const openCreate = () => {
    setEditing(null);
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditing(server);
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  const handleToggle = async (server: McpServer, enabled: boolean) => {
    try {
      await api.mcpServers.set(slug, server.slug, {
        name: server.name,
        url: server.url,
        authMode: server.authMode,
        enabled,
        config: server.config,
      });
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("mcp.toggleFailed")));
    }
    reload();
  };

  const handleConnectShared = async (server: McpServer) => {
    // Opened before the request, while the click still counts as a user
    // gesture: a window opened after an await is blocked by most browsers.
    const tab = window.open("", "_blank");
    try {
      const { authorizeUrl } = await api.mcpServers.connectShared(slug, server.slug);
      if (tab) {
        tab.opener = null;
        tab.location.assign(authorizeUrl);
      } else {
        window.location.assign(authorizeUrl);
      }
      setConnecting(server.slug);
    } catch (err) {
      tab?.close();
      toast.error(getUserErrorMessage(err, t("mcp.shared.connectFailed")));
    }
  };

  const handleDisconnectShared = async (server: McpServer) => {
    try {
      await api.mcpServers.disconnectShared(slug, server.slug);
      toast.success(t("mcp.shared.disconnected"));
      reload();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("mcp.shared.disconnectFailed")));
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api.mcpServers.delete(slug, deleting.slug);
      toast.success(t("mcp.deleted"));
      setDeleting(null);
      reload();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("mcp.deleteFailed")));
    }
  };

  if (error && data === undefined) return <LoadFailed message={t("mcp.loadFailed")} onRetry={reload} />;

  if (loading && data === undefined) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* The page draws the title and the line under it; the long explanation
          of static and OAuth servers lives in the server's dialog. */}
      <SectionActions>
        <Button onClick={openCreate} size="sm">
          <Plus className="mr-1 size-4" />
          {t("mcp.add")}
        </Button>
      </SectionActions>

      {servers.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
          <p>{t("mcp.empty")}</p>
        </div>
      ) : (
        <ListTable>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <ListHead className="w-[26%]">{t("mcp.col.name")}</ListHead>
              <ListHead>{t("mcp.col.url")}</ListHead>
              <ListHead className="w-40">{t("mcp.col.auth")}</ListHead>
              <ListHead className="w-24">{t("mcp.col.enabled")}</ListHead>
              <ListHead align="end" className="w-28">{t("mcp.col.actions")}</ListHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {servers.map((server) => (
              <ListRow key={server.id} muted={!server.enabled}>
                <ListNameCell name={server.name} summary={<code className="text-xs">{server.slug}</code>} />
                <TableCell>
                  <span className="truncate block text-xs text-muted-foreground">{server.url}</span>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {t(`mcp.authMode.${server.authMode}` as const)}
                  </Badge>
                  {server.authMode === "oauth" && server.config.account === "shared" && (
                    <SharedAccountState
                      server={server}
                      waiting={connecting === server.slug}
                      onConnect={() => handleConnectShared(server)}
                      onDisconnect={() => handleDisconnectShared(server)}
                    />
                  )}
                </TableCell>
                <ListControlCell className="text-left">
                  <Switch
                    checked={server.enabled}
                    onCheckedChange={(v) => handleToggle(server, v)}
                  />
                </ListControlCell>
                <ListControlCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon" className="size-8" onClick={() => openEdit(server)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive"
                      onClick={() => setDeleting(server)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </ListControlCell>
              </ListRow>
            ))}
          </TableBody>
        </ListTable>
      )}

      <McpServerDialog
        key={dialogKey}
        agentSlug={slug}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        takenSlugs={servers.map((server) => server.slug)}
        onSaved={reload}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("mcp.deleteTitle")}
        description={t("mcp.deleteDescription", { name: deleting?.name ?? "" })}
        confirmLabel={t("common.delete")}
        onConfirm={handleDelete}
      />
    </div>
  );
}

/** Whether the agent's shared account is connected, and the control that changes it. */
function SharedAccountState({
  server,
  waiting,
  onConnect,
  onDisconnect,
}: {
  server: McpServer;
  waiting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const connected = server.sharedAccount ?? null;
  return (
    <div className="mt-1.5 space-y-1">
      <p className="text-xs text-muted-foreground">
        {connected
          ? t("mcp.shared.connectedOn", {
              date: fmt.date(connected.connectedAt),
            })
          : waiting
            ? t("mcp.shared.waiting")
            : t("mcp.shared.notConnected")}
      </p>
      {connected ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onDisconnect}>
          <Unlink className="mr-1 size-3.5" />
          {t("mcp.shared.disconnect")}
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onConnect}>
          <Link2 className="mr-1 size-3.5" />
          {t("mcp.shared.connect")}
        </Button>
      )}
    </div>
  );
}
