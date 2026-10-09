// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { PROVIDER_CREDENTIAL_KEYS } from "@/lib/provider-secrets";
import { useSecretSpecs } from "@/components/instance-secret/use-secret-specs";
import {
  HOOK_EVENTS,
  HookEventField,
  HookParamFields,
  HookRunFields,
  HookSheet,
  StreamingWarning,
  type HookSettings,
} from "./hook-sheet";
import { SectionActions } from "./section-actions";

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
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [openHookId, setOpenHookId] = useState<string | null>(null);
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
    The keys a hook function declares, set beside the hook that asks for them —
    in its sheet, and in the Add dialog once a function is chosen. Provider
    credentials stay in the Modello section. One form holds every function's
    keys: a key belongs to the agent, and several hooks can ask for the same one.
  */
  const specsOf = useCallback(
    (functionName: string): RequiredSecretSpec[] =>
      (catalog.find((fn) => fn.name === functionName)?.requiredSecrets ?? []).filter(
        (spec) => !PROVIDER_CREDENTIAL_KEYS.has(spec.key),
      ),
    [catalog],
  );
  const allSpecs = useMemo(() => {
    const byKey = new Map<string, RequiredSecretSpec>();
    for (const fn of catalog) for (const spec of specsOf(fn.name)) if (!byKey.has(spec.key)) byKey.set(spec.key, spec);
    return [...byKey.values()];
  }, [catalog, specsOf]);
  const params = useSecretSpecs(slug, allSpecs);
  const missingParams = (hook: InstanceHook) =>
    !params.loading &&
    params.canRead &&
    specsOf(hook.actionConfig.functionName).some((spec) => spec.optional !== true && !params.isConfigured(spec.key));

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  // Keys typed in the dialog and then abandoned must not reappear in a sheet.
  const onDialogOpenChange = (open: boolean) => {
    if (!open && !saving) params.reset();
    setDialogOpen(open);
  };

  const handleSave = async () => {
    if (!form.functionName) {
      toast.error(t("hooks.functionRequired"));
      return;
    }
    setSaving(true);
    try {
      // The keys first: the hook runs on its next event and must find them set.
      if (params.dirty) await params.save();
      await api.hooks.create(slug, {
        event: form.event,
        actionConfig: { functionName: form.functionName },
        timeoutMs: form.timeoutMs,
        position: form.position,
      });
      toast.success(t("hooks.saved"));
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async (hook: InstanceHook, settings: HookSettings) => {
    await api.hooks.update(slug, hook.id, settings);
    await load();
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
      if (openHookId === deleting.id) setOpenHookId(null);
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
  const openHook = openHookId ? hooks.find((h) => h.id === openHookId) ?? null : null;

  return (
    <div className="space-y-6">
      <SectionActions>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          {t("hooks.add")}
        </Button>
      </SectionActions>

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
                      <div
                        key={hook.id}
                        data-state={openHookId === hook.id ? "selected" : undefined}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 p-3 hover:bg-muted/50",
                          "data-[state=selected]:bg-muted",
                        )}
                        onClick={() => setOpenHookId(hook.id)}
                      >
                        <button
                          type="button"
                          className="text-left hover:underline"
                          aria-label={t("hooks.open", { function: named ? fnName : t("hooks.unknownAction") })}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenHookId(hook.id);
                          }}
                        >
                          {named ? (
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{fnName}</code>
                          ) : (
                            <span className="text-sm text-muted-foreground">{t("hooks.unknownAction")}</span>
                          )}
                        </button>
                        {named && !knownFunctions.has(fnName) && (
                          <Badge variant="destructive">{t("hooks.unknownFunction")}</Badge>
                        )}
                        {hook.enabled && missingParams(hook) && (
                          <Badge variant="outline" className="text-warning">{t("hooks.paramsMissing")}</Badge>
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
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t("hooks.enabledLabel")}
                            onCheckedChange={(v) => handleToggle(hook, v)}
                          />
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

      <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("hooks.createTitle")}</DialogTitle>
            <DialogDescription>{t("hooks.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <HookEventField value={form} onChange={(next) => setForm((f) => ({ ...f, ...next }))} />
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
              {selectedFn?.mutatesResponse && <StreamingWarning />}
            </div>
            <HookRunFields value={form} onChange={(next) => setForm((f) => ({ ...f, ...next }))} />
            {selectedFn && specsOf(selectedFn.name).length > 0 && (
              <section className="space-y-4 border-t pt-4">
                <h3 className="text-sm font-medium">{t("hooks.params")}</h3>
                <HookParamFields specs={specsOf(selectedFn.name)} params={params} />
              </section>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onDialogOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <HookSheet
        hook={openHook}
        fn={openHook ? catalog.find((fn) => fn.name === openHook.actionConfig.functionName) ?? null : null}
        specs={openHook ? specsOf(openHook.actionConfig.functionName) : []}
        params={params}
        onSaveSettings={saveSettings}
        onDelete={setDeleting}
        onClose={() => setOpenHookId(null)}
      />

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
