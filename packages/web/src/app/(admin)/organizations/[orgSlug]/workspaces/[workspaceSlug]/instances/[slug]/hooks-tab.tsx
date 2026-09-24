// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { api, getUserErrorMessage, type HookEvent, type InstanceHook, type HookFunctionInfo, type RequiredSecretSpec } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { PROVIDER_CREDENTIAL_KEYS } from "@/lib/provider-secrets";
import { SecretSpecField } from "@/components/instance-secret/secret-spec-field";
import { useSecretSpecs } from "@/components/instance-secret/use-secret-specs";

const HOOK_EVENTS: HookEvent[] = [
  "conversation_start",
  "message_received",
  "response_generated",
  "response_sent",
];

interface Props {
  slug: string;
}

interface FormState {
  event: HookEvent;
  functionName: string;
  timeoutMs: number;
  position: number;
}

const EMPTY_FORM: FormState = {
  event: "conversation_start",
  functionName: "",
  timeoutMs: 10000,
  position: 0,
};

export function HooksTab({ slug }: Props) {
  const { t } = useI18n();
  const [hooks, setHooks] = useState<InstanceHook[]>([]);
  const [catalog, setCatalog] = useState<HookFunctionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<InstanceHook | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<InstanceHook | null>(null);

  const load = useCallback(async () => {
    try {
      const [hooksRes, catalogRes] = await Promise.all([
        api.hooks.list(slug),
        api.hooks.functions(),
      ]);
      setHooks(hooksRes.hooks);
      setCatalog(catalogRes.hookFunctions);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    The keys the ENABLED hooks declare, each with the hooks that ask for it. They
    used to sit on a page of their own, mixed with the tools' keys and saying
    neither which hook wanted them nor why; a key exists because a hook asked for
    it, so it is set beside the hooks. Provider credentials stay in the Modello section.
  */
  const hookParams = useMemo(() => {
    const enabled = new Set(hooks.filter((h) => h.enabled).map((h) => h.actionConfig.functionName));
    const byKey = new Map<string, { spec: RequiredSecretSpec; askedBy: string[] }>();
    for (const fn of catalog) {
      if (!enabled.has(fn.name)) continue;
      for (const spec of fn.requiredSecrets) {
        if (PROVIDER_CREDENTIAL_KEYS.has(spec.key)) continue;
        const entry = byKey.get(spec.key) ?? { spec, askedBy: [] };
        entry.askedBy.push(fn.name);
        byKey.set(spec.key, entry);
      }
    }
    return [...byKey.values()];
  }, [hooks, catalog]);
  const paramSpecs = useMemo(() => hookParams.map((p) => p.spec), [hookParams]);
  const params = useSecretSpecs(slug, paramSpecs);
  const [savingParams, setSavingParams] = useState(false);

  // Its own button: every other action on this page writes at once, so a
  // page-level Save would be the one thing here that waits.
  const saveParams = async () => {
    setSavingParams(true);
    try {
      await params.save();
      toast.success(t("hooks.paramsSaved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    } finally {
      setSavingParams(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (hook: InstanceHook) => {
    setEditing(hook);
    setForm({
      event: hook.event,
      functionName: hook.actionConfig.functionName,
      timeoutMs: hook.timeoutMs,
      position: hook.position,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.functionName) {
      toast.error(t("hooks.functionRequired"));
      return;
    }
    setSaving(true);
    try {
      const data = {
        event: form.event,
        actionConfig: { functionName: form.functionName },
        timeoutMs: form.timeoutMs,
        position: form.position,
      };
      if (editing) {
        await api.hooks.update(slug, editing.id, data);
      } else {
        await api.hooks.create(slug, data);
      }
      toast.success(t("hooks.saved"));
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (hook: InstanceHook, enabled: boolean) => {
    setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, enabled } : h)));
    try {
      await api.hooks.update(slug, hook.id, { enabled });
      toast.success(t(enabled ? "hooks.enabled" : "hooks.disabled"));
    } catch (err) {
      setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, enabled: hook.enabled } : h)));
      toast.error(getUserErrorMessage(err, t("hooks.saveFailed")));
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api.hooks.delete(slug, deleting.id);
      toast.success(t("hooks.deleted"));
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.deleteFailed")));
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const knownFunctions = new Set(catalog.map((fn) => fn.name));
  const selectedFn = catalog.find((fn) => fn.name === form.functionName);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-medium">{t("hooks.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("hooks.description")}</p>
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          {t("hooks.add")}
        </Button>
      </div>

      {hooks.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("hooks.empty")}
        </p>
      ) : (
        <div className="space-y-6">
          {HOOK_EVENTS.map((event) => {
            const eventHooks = hooks.filter((h) => h.event === event);
            if (eventHooks.length === 0) return null;
            return (
              <div key={event}>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                  {t(`hooks.events.${event}`)}
                </h3>
                <div className="divide-y rounded-md border">
                  {eventHooks.map((hook) => {
                    /*
                      A row is ALWAYS named. A hook whose action lost its function
                      rendered an empty `<code>` followed by a red badge — a row
                      with a destructive-looking state and nothing saying which
                      hook it was, so the only way to identify it was to open the
                      edit dialog. The fallback names the condition instead.
                    */
                    const fnName = hook.actionConfig.functionName;
                    const named = fnName && fnName.trim().length > 0;

                    return (
                      <div key={hook.id} className="flex items-center gap-3 p-3">
                        {named ? (
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{fnName}</code>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {t("hooks.unknownAction")}
                          </span>
                        )}
                        {named && !knownFunctions.has(fnName) && (
                          <Badge variant="destructive">{t("hooks.unknownFunction")}</Badge>
                        )}
                        {/* Both metadata are LABELLED: "10s" and "0" beside a name
                            said nothing about which number was which. */}
                        <span className="text-xs text-muted-foreground">
                          {t("hooks.timeoutLabel")} {hook.timeoutMs / 1000}s
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t("hooks.position")} {hook.position}
                        </span>
                        <div className="ml-auto flex items-center gap-2">
                          <Switch
                            checked={hook.enabled}
                            aria-label={t("hooks.enabledLabel")}
                            onCheckedChange={(v) => handleToggle(hook, v)}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t("common.edit")}
                            onClick={() => openEdit(hook)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t("common.delete")}
                            className="text-destructive"
                            onClick={() => setDeleting(hook)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hookParams.length > 0 && (
        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t("hooks.params")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("hooks.paramsHelp")}</p>
          </div>
          {!params.canRead && <p className="text-sm text-muted-foreground">{t("tools.paramsNoAccess")}</p>}
          {params.canRead &&
            hookParams.map(({ spec, askedBy }) => (
              <div key={spec.key} className="space-y-1.5">
                <SecretSpecField spec={spec} form={params} />
                <p className="text-xs text-muted-foreground">{t("tools.paramAskedBy", { names: askedBy.join(", ") })}</p>
              </div>
            ))}
          {params.canRead && (
            <div className="flex justify-end">
              <Button size="sm" onClick={saveParams} disabled={!params.dirty || savingParams}>
                {t("tools.paramsSave")}
              </Button>
            </div>
          )}
        </section>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? t("hooks.editTitle") : t("hooks.createTitle")}</DialogTitle>
            <DialogDescription>{t("hooks.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("hooks.event")}</Label>
              <Select
                value={form.event}
                onValueChange={(v) => setForm((f) => ({ ...f, event: v as HookEvent }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_EVENTS.map((event) => (
                    <SelectItem key={event} value={event}>
                      {t(`hooks.events.${event}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("hooks.function")}</Label>
              <Select
                value={form.functionName || undefined}
                onValueChange={(v) => setForm((f) => ({ ...f, functionName: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("hooks.functionPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {catalog.map((fn) => (
                    <SelectItem key={fn.name} value={fn.name}>
                      {fn.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedFn?.description && (
                <p className="text-xs text-muted-foreground">{selectedFn.description}</p>
              )}
              {selectedFn?.mutatesResponse && (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t("hooks.streamingWarning")}</span>
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("hooks.timeout")}</Label>
                <Input
                  type="number"
                  min={1000}
                  max={30000}
                  step={1000}
                  value={form.timeoutMs}
                  onChange={(e) => setForm((f) => ({ ...f, timeoutMs: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("hooks.position")}</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.position}
                  onChange={(e) => setForm((f) => ({ ...f, position: Number(e.target.value) }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("hooks.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("hooks.deleteDescription", { function: deleting?.actionConfig.functionName ?? "" })}
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
