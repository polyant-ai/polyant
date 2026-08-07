// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Loader2, CheckCircle2, XCircle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, getUserErrorMessage, type McpAuthMode, type McpServer, type McpTestResult } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface Props {
  slug: string;
}

type StaticAuthType = "bearer" | "header";

interface FormState {
  slug: string;
  name: string;
  url: string;
  authMode: McpAuthMode;
  enabled: boolean;
  allowList: string;
  staticAuthType: StaticAuthType;
  headerName: string;
  token: string;
  tokenPlaceholder: string;
  scopes: string;
  advancedOpen: boolean;
  staticClientId: string;
  staticClientSecret: string;
  staticClientSecretPlaceholder: string;
}

const EMPTY_FORM: FormState = {
  slug: "",
  name: "",
  url: "",
  authMode: "static",
  enabled: true,
  allowList: "",
  staticAuthType: "bearer",
  headerName: "",
  token: "",
  tokenPlaceholder: "",
  scopes: "",
  advancedOpen: false,
  staticClientId: "",
  staticClientSecret: "",
  staticClientSecretPlaceholder: "",
};

function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function joinList(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "";
}

/** Builds the config payload sent to the engine; blank secret fields are omitted so the
 * server restores the existing masked value (`mergeMaskedMcpSecrets`) instead of clearing it. */
function buildConfig(form: FormState): Record<string, unknown> {
  const allowList = splitList(form.allowList);
  // No credential at all. The engine's schema for this mode is `.strict()`, so
  // sending a leftover token here would be a 400 rather than a secret stored for
  // nothing — hence only the allowList, which is about which tools may be called
  // and has nothing to do with how the server authenticates.
  if (form.authMode === "none") {
    return allowList.length ? { allowList } : {};
  }
  if (form.authMode === "static") {
    const auth: Record<string, unknown> =
      form.staticAuthType === "header"
        ? { type: "header", headerName: form.headerName }
        : { type: "bearer" };
    if (form.token) auth.token = form.token;
    return { auth, ...(allowList.length ? { allowList } : {}) };
  }
  const scopes = splitList(form.scopes);
  const config: Record<string, unknown> = {};
  if (scopes.length) config.scopes = scopes;
  if (allowList.length) config.allowList = allowList;
  if (form.staticClientId || form.staticClientSecret) {
    const staticClient: Record<string, unknown> = {};
    if (form.staticClientId) staticClient.clientId = form.staticClientId;
    if (form.staticClientSecret) staticClient.clientSecret = form.staticClientSecret;
    config.staticClient = staticClient;
  }
  return config;
}

function formFromServer(server: McpServer): FormState {
  const config = server.config;
  const base: FormState = {
    ...EMPTY_FORM,
    slug: server.slug,
    name: server.name,
    url: server.url,
    authMode: server.authMode,
    enabled: server.enabled,
    allowList: joinList(config.allowList),
  };
  if (server.authMode === "static") {
    const auth = (config.auth as { type?: string; headerName?: string; token?: string } | undefined) ?? {};
    return {
      ...base,
      staticAuthType: auth.type === "header" ? "header" : "bearer",
      headerName: auth.headerName ?? "",
      tokenPlaceholder: typeof auth.token === "string" ? auth.token : "",
    };
  }
  const staticClient = config.staticClient as { clientId?: string; clientSecret?: string } | undefined;
  return {
    ...base,
    scopes: joinList(config.scopes),
    advancedOpen: !!staticClient,
    staticClientId: staticClient?.clientId ?? "",
    staticClientSecretPlaceholder: typeof staticClient?.clientSecret === "string" ? staticClient.clientSecret : "",
  };
}

export function McpServersTab({ slug }: Props) {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<McpServer | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.mcpServers.list(slug);
      setServers(res);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("mcp.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setTestResult(null);
    setDialogOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditing(server);
    setForm(formFromServer(server));
    setTestResult(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name || !form.url) {
      toast.error(t("mcp.validation.required"));
      return;
    }
    if (!editing && !form.slug) {
      toast.error(t("mcp.validation.slugRequired"));
      return;
    }
    if (form.authMode === "static" && !editing && !form.token) {
      toast.error(t("mcp.validation.tokenRequired"));
      return;
    }
    if (form.authMode === "static" && form.staticAuthType === "header" && !form.headerName) {
      toast.error(t("mcp.validation.headerNameRequired"));
      return;
    }
    setSaving(true);
    try {
      const serverSlug = editing ? editing.slug : form.slug;
      await api.mcpServers.set(slug, serverSlug, {
        name: form.name,
        url: form.url,
        authMode: form.authMode,
        enabled: form.enabled,
        config: buildConfig(form),
      });
      toast.success(editing ? t("mcp.updated") : t("mcp.created"));
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("mcp.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (server: McpServer, enabled: boolean) => {
    setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled } : s)));
    try {
      await api.mcpServers.set(slug, server.slug, {
        name: server.name,
        url: server.url,
        authMode: server.authMode,
        enabled,
        config: server.config,
      });
    } catch (err) {
      setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled: server.enabled } : s)));
      toast.error(getUserErrorMessage(err, t("mcp.toggleFailed")));
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api.mcpServers.delete(slug, deleting.slug);
      toast.success(t("mcp.deleted"));
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("mcp.deleteFailed")));
    }
  };

  const handleTest = async () => {
    if (!form.url) {
      toast.error(t("mcp.validation.urlRequiredForTest"));
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.mcpServers.test(slug, {
        slug: form.slug || undefined,
        name: form.name || form.slug,
        url: form.url,
        authMode: form.authMode,
        enabled: form.enabled,
        config: buildConfig(form),
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: getUserErrorMessage(err, t("mcp.test.failed")) });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        {/* No heading of its own: the section IS "MCP" now, and the h3 under it
            said "Server MCP" — the same thing twice. It earned its place while
            this was a block at the bottom of the Tools page, which it no longer
            is. The description stays; it says something the title cannot. */}
        <div>
          <p className="text-sm text-muted-foreground">{t("mcp.description")}</p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="mr-1 size-4" />
          {t("mcp.add")}
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
          <p>{t("mcp.empty")}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mcp.col.name")}</TableHead>
                <TableHead>{t("mcp.col.url")}</TableHead>
                <TableHead>{t("mcp.col.auth")}</TableHead>
                <TableHead>{t("mcp.col.enabled")}</TableHead>
                <TableHead className="text-right">{t("mcp.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((server) => (
                <TableRow key={server.id} className={!server.enabled ? "opacity-60" : undefined}>
                  <TableCell className="max-w-[220px]">
                    <div className="truncate font-medium">{server.name}</div>
                    <code className="text-xs text-muted-foreground">{server.slug}</code>
                  </TableCell>
                  <TableCell className="max-w-[260px]">
                    <span className="truncate block text-xs text-muted-foreground">{server.url}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {t(`mcp.authMode.${server.authMode}` as const)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={(v) => handleToggle(server, v)}
                    />
                  </TableCell>
                  <TableCell>
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{editing ? t("mcp.editTitle") : t("mcp.createTitle")}</DialogTitle>
            <DialogDescription>{t("mcp.dialogDescription")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto flex-1 pr-1">
            <div className="space-y-2">
              <Label>{t("mcp.form.slug")}</Label>
              <Input
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }))}
                readOnly={!!editing}
                className={editing ? "opacity-60" : ""}
                placeholder="my-mcp-server"
              />
            </div>

            <div className="space-y-2">
              <Label>{t("mcp.form.name")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My MCP Server"
              />
            </div>

            <div className="space-y-2">
              <Label>{t("mcp.form.url")}</Label>
              <Input
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="https://mcp.example.com/mcp"
              />
            </div>

            <div className="space-y-2">
              <Label>{t("mcp.form.authMode")}</Label>
              <Select
                value={form.authMode}
                onValueChange={(v) => setForm((f) => ({ ...f, authMode: v as McpAuthMode }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("mcp.authMode.none")}</SelectItem>
                  <SelectItem value="static">{t("mcp.authMode.static")}</SelectItem>
                  <SelectItem value="oauth">{t("mcp.authMode.oauth")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.authMode === "none" ? (
              // Deliberately empty: the point of this mode is that there is
              // nothing to ask for. A note, not a disabled field, so the form does
              // not look like it is withholding something.
              <p className="text-sm text-muted-foreground">{t("mcp.form.noAuthHelp")}</p>
            ) : form.authMode === "static" ? (
              <>
                <div className="space-y-2">
                  <Label>{t("mcp.form.staticAuthType")}</Label>
                  <Select
                    value={form.staticAuthType}
                    onValueChange={(v) => setForm((f) => ({ ...f, staticAuthType: v as StaticAuthType }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bearer">{t("mcp.form.bearer")}</SelectItem>
                      <SelectItem value="header">{t("mcp.form.header")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.staticAuthType === "header" && (
                  <div className="space-y-2">
                    <Label>{t("mcp.form.headerName")}</Label>
                    <Input
                      value={form.headerName}
                      onChange={(e) => setForm((f) => ({ ...f, headerName: e.target.value }))}
                      placeholder="X-Api-Key"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label>{t("mcp.form.token")}</Label>
                  <Input
                    type="password"
                    value={form.token}
                    onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                    placeholder={form.tokenPlaceholder || undefined}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>{t("mcp.form.scopes")}</Label>
                  <Input
                    value={form.scopes}
                    onChange={(e) => setForm((f) => ({ ...f, scopes: e.target.value }))}
                    placeholder="read, write"
                  />
                  <p className="text-xs text-muted-foreground">{t("mcp.form.scopesHelp")}</p>
                </div>
                <p className="text-xs text-muted-foreground">{t("mcp.form.oauthNote")}</p>
                <Collapsible
                  open={form.advancedOpen}
                  onOpenChange={(open) => setForm((f) => ({ ...f, advancedOpen: open }))}
                >
                  <CollapsibleTrigger className="flex w-full items-center gap-2 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                    <ChevronDown className={`size-4 transition-transform ${form.advancedOpen ? "" : "-rotate-90"}`} />
                    {t("mcp.form.advanced")}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mt-2 space-y-4">
                      <div className="space-y-2">
                        <Label>{t("mcp.form.staticClientId")}</Label>
                        <Input
                          value={form.staticClientId}
                          onChange={(e) => setForm((f) => ({ ...f, staticClientId: e.target.value }))}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t("mcp.form.staticClientSecret")}</Label>
                        <Input
                          type="password"
                          value={form.staticClientSecret}
                          onChange={(e) => setForm((f) => ({ ...f, staticClientSecret: e.target.value }))}
                          placeholder={form.staticClientSecretPlaceholder || undefined}
                        />
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}

            <div className="space-y-2 border-t pt-4">
              <Label>{t("mcp.form.allowList")}</Label>
              <Input
                value={form.allowList}
                onChange={(e) => setForm((f) => ({ ...f, allowList: e.target.value }))}
                placeholder="search, get_page"
              />
              <p className="text-xs text-muted-foreground">{t("mcp.form.allowListHelp")}</p>
            </div>

            <div className="space-y-2 border-t pt-4">
              <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
                {testing && <Loader2 className="mr-1 size-4 animate-spin" />}
                {testing ? t("mcp.test.testing") : t("mcp.test.button")}
              </Button>
              {testResult && (
                <div
                  className={`rounded-md border p-3 text-sm ${
                    testResult.ok ? "border-success/30 bg-success/10" : "border-destructive/30 bg-destructive/10"
                  }`}
                >
                  {testResult.ok ? (
                    testResult.requiresOAuth ? (
                      <p className="flex items-center gap-1.5 text-success">
                        <CheckCircle2 className="size-3.5 shrink-0" />
                        {t("mcp.test.requiresOAuth")}
                      </p>
                    ) : (
                      <div>
                        <p className="flex items-center gap-1.5 text-success">
                          <CheckCircle2 className="size-3.5 shrink-0" />
                          {t("mcp.test.success")}
                        </p>
                        {testResult.tools && testResult.tools.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {testResult.tools.map((toolName) => (
                              <Badge key={toolName} variant="secondary" className="text-xs">
                                {toolName}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-1 text-xs text-muted-foreground">{t("mcp.test.noTools")}</p>
                        )}
                      </div>
                    )
                  ) : (
                    <p className="flex items-center gap-1.5 text-destructive">
                      <XCircle className="size-3.5 shrink-0" />
                      {testResult.error ?? t("mcp.test.failed")}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("mcp.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("mcp.deleteDescription", { name: deleting?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
