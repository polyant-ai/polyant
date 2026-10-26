// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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
import { LoadFailed } from "@/components/ui/load-failed";
import { StatusBadge } from "@/components/status-badge";
import { ListDrawer } from "@/components/list-drawer";
import { ListEmpty, ListLoading } from "@/components/list-states";
import { SwitchList } from "@/components/switch-list";
import { useResource } from "@/hooks/use-resource";
import { useReloadFailureToast } from "@/hooks/use-reload-failure-toast";
import { api, getUserErrorMessage, type HookEvent, type InstanceHook, type HookFunctionInfo, type RequiredSecretSpec } from "@/lib/api";
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
import { hookSummary } from "./tools-tab-helpers";

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

const NO_HOOKS: InstanceHook[] = [];
const NO_CATALOG: HookFunctionInfo[] = [];

export function HooksTab({ slug }: Props) {
  const { t, locale } = useI18n();
  const { data, error, loading, reload: load, mutate } = useResource(["hooks", slug], async () => {
    const [hooksRes, catalogRes] = await Promise.all([api.hooks.list(slug), api.hooks.functions()]);
    return { hooks: hooksRes.hooks, catalog: catalogRes.hookFunctions };
  });
  useReloadFailureToast(error, data !== undefined, t("hooks.loadFailed"));
  const hooks = data?.hooks ?? NO_HOOKS;
  const catalog = data?.catalog ?? NO_CATALOG;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [openHookId, setOpenHookId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<InstanceHook | null>(null);

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
      load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async (hook: InstanceHook, settings: HookSettings) => {
    await api.hooks.update(slug, hook.id, settings);
    load();
  };

  const handleToggle = async (hook: InstanceHook, enabled: boolean) => {
    try {
      await api.hooks.update(slug, hook.id, { enabled });
      toast.success(t(enabled ? "hooks.enabled" : "hooks.disabled"));
      await load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.saveFailed")));
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api.hooks.delete(slug, deleting.id);
      toast.success(t("hooks.deleted"));
      if (openHookId === deleting.id) setOpenHookId(null);
      setDeleting(null);
      mutate((current) => ({ ...current, hooks: current.hooks.filter((h) => h.id !== deleting.id) }));
      load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.deleteFailed")));
    }
  };

  if (error && data === undefined) return <LoadFailed message={t("hooks.loadFailed")} onRetry={load} />;

  if (loading && data === undefined) return <ListLoading className="" />;

  const knownFunctions = new Set(catalog.map((fn) => fn.name));
  const selectedFn = catalog.find((fn) => fn.name === form.functionName);
  const orderedHooks = HOOK_EVENTS.flatMap((event) =>
    hooks.filter((h) => h.event === event).sort((a, b) => a.position - b.position),
  );
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
        <ListEmpty className="mt-8" title={t("hooks.empty")} />
      ) : (
        <SwitchList
          rows={orderedHooks}
          rowKey={(hook) => hook.id}
          // A row is ALWAYS named: a hook whose action lost its function would
          // otherwise be a row with a red badge and nothing saying which hook it was.
          name={(hook) => (hook.actionConfig.functionName?.trim() ? hook.actionConfig.functionName : t("hooks.unknownAction"))}
          nameHeader={t("hooks.function")}
          summary={(hook) => {
            const fn = catalog.find((entry) => entry.name === hook.actionConfig.functionName);
            return fn ? hookSummary(fn, locale) || undefined : undefined;
          }}
          badges={(hook) => {
            const fnName = hook.actionConfig.functionName;
            return (
              <>
                {fnName?.trim() && !knownFunctions.has(fnName) && (
                  <Badge variant="destructive">{t("hooks.unknownFunction")}</Badge>
                )}
                {hook.enabled && missingParams(hook) && (
                  <StatusBadge tone="negative">{t("hooks.paramsMissing")}</StatusBadge>
                )}
              </>
            );
          }}
          searchText={(hook) => [t(`hooks.events.${hook.event}`)]}
          // Hooks run in order: by the event's place in the conversation, then by their position.
          sortKey={null}
          columns={[
            {
              header: t("hooks.event"),
              className: "w-44",
              cell: (hook) => <Badge variant="secondary">{t(`hooks.events.${hook.event}`)}</Badge>,
            },
            { header: t("hooks.timeoutLabel"), className: "w-28", cell: (hook) => `${hook.timeoutMs / 1000}s` },
            { header: t("hooks.position"), className: "w-24", cell: (hook) => hook.position },
          ]}
          isOn={(hook) => hook.enabled}
          onToggle={handleToggle}
          switchLabel={(hook) => t("common.activeNamed", { name: hook.actionConfig.functionName || t("hooks.unknownAction") })}
          onOpen={(hook) => setOpenHookId(hook.id)}
          openLabel={(hook) => t("hooks.open", { function: hook.actionConfig.functionName || t("hooks.unknownAction") })}
          selectedKey={openHookId}
        />
      )}

      <ListDrawer
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        title={t("hooks.createTitle")}
        description={t("hooks.dialogDescription")}
        primary={
          <Button onClick={handleSave} disabled={saving || !form.functionName}>
            {saving ? t("common.saving") : t("common.add")}
          </Button>
        }
      >
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
            {selectedFn && hookSummary(selectedFn, locale) && (
              <p className="text-xs text-muted-foreground">{hookSummary(selectedFn, locale)}</p>
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
      </ListDrawer>

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
              variant="destructive"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
