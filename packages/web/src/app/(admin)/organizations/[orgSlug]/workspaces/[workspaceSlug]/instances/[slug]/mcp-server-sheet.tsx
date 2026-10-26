// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, CheckCircle2, XCircle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DrawerDeleteButton, ListDrawer } from "@/components/list-drawer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  api,
  getUserErrorMessage,
  type McpAuthMode,
  type McpOAuthAccount,
  type McpServer,
  type McpTestResult,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

type StaticAuthType = "bearer" | "header";

interface FormState {
  slug: string;
  name: string;
  url: string;
  authMode: McpAuthMode;
  oauthAccount: McpOAuthAccount;
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
  oauthAccount: "conversation",
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
  const config: Record<string, unknown> = { account: form.oauthAccount };
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
    oauthAccount: config.account === "shared" ? "shared" : "conversation",
    scopes: joinList(config.scopes),
    advancedOpen: !!staticClient,
    staticClientId: staticClient?.clientId ?? "",
    staticClientSecretPlaceholder: typeof staticClient?.clientSecret === "string" ? staticClient.clientSecret : "",
  };
}

/**
 * The add / edit form of one MCP server, with its connection test, in a drawer.
 * Mounted fresh for each opening (the parent changes `key`), so the form starts
 * from the server being edited or from an empty one.
 */
export function McpServerSheet({
  agentSlug,
  open,
  onOpenChange,
  editing,
  takenSlugs,
  onSaved,
  onDelete,
  accountState,
}: {
  agentSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: McpServer | null;
  takenSlugs: readonly string[];
  onSaved: () => void;
  /** Asks to delete the server being edited; the page confirms and does it. */
  onDelete?: (server: McpServer) => void;
  /** Whether the agent's shared account is connected, and the control that changes it. */
  accountState?: ReactNode;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(() => (editing ? formFromServer(editing) : EMPTY_FORM));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  /** What the engine would refuse is not offered: the button waits for a complete form. */
  const valid =
    Boolean(form.name && form.url) &&
    (editing || (Boolean(form.slug) && !takenSlugs.includes(form.slug))) &&
    !(form.authMode === "static" && !editing && !form.token) &&
    !(form.authMode === "static" && form.staticAuthType === "header" && !form.headerName);

  const handleSave = async () => {
    if (!form.name || !form.url) {
      toast.error(t("mcp.validation.required"));
      return;
    }
    if (!editing && !form.slug) {
      toast.error(t("mcp.validation.slugRequired"));
      return;
    }
    // Saving is an upsert: a new server under a taken slug would replace that one.
    if (!editing && takenSlugs.includes(form.slug)) {
      toast.error(t("mcp.validation.slugTaken"));
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
      await api.mcpServers.set(agentSlug, serverSlug, {
        name: form.name,
        url: form.url,
        authMode: form.authMode,
        enabled: form.enabled,
        config: buildConfig(form),
      });
      toast.success(editing ? t("mcp.updated") : t("mcp.created"));
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("mcp.saveFailed")));
    } finally {
      setSaving(false);
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
      const result = await api.mcpServers.test(agentSlug, {
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

  return (
    <ListDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? editing.name : t("mcp.createTitle")}
      description={editing ? editing.url : t("mcp.dialogDescription")}
      destructive={editing && onDelete ? <DrawerDeleteButton onClick={() => onDelete(editing)} /> : undefined}
      primary={
        <Button onClick={handleSave} disabled={saving || !valid}>
          {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
          {saving ? t("common.saving") : editing ? t("common.save") : t("common.add")}
        </Button>
      }
    >
      <div className="space-y-4">
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
              <Label>{t("mcp.form.oauthAccount")}</Label>
              <Select
                value={form.oauthAccount}
                onValueChange={(v) => setForm((f) => ({ ...f, oauthAccount: v as McpOAuthAccount }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="conversation">{t("mcp.form.oauthAccount.conversation")}</SelectItem>
                  <SelectItem value="shared">{t("mcp.form.oauthAccount.shared")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.oauthAccount === "shared" ? t("mcp.form.sharedNote") : t("mcp.form.oauthNote")}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("mcp.form.scopes")}</Label>
              <Input
                value={form.scopes}
                onChange={(e) => setForm((f) => ({ ...f, scopes: e.target.value }))}
                placeholder="read, write"
              />
              <p className="text-xs text-muted-foreground">{t("mcp.form.scopesHelp")}</p>
            </div>
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

        {editing && accountState}

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
                    {form.authMode === "oauth" && form.oauthAccount === "shared"
                      ? t("mcp.test.requiresSharedConnection")
                      : t("mcp.test.requiresOAuth")}
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
                          <Badge key={toolName} variant="secondary">
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
    </ListDrawer>
  );
}
