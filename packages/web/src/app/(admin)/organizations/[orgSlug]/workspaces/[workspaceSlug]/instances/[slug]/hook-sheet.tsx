// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { getUserErrorMessage, type HookEvent, type HookFunctionInfo, type InstanceHook, type RequiredSecretSpec } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { SecretSpecField, humanizeSecretKey } from "@/components/instance-secret/secret-spec-field";
import type { SecretSpecsForm } from "@/components/instance-secret/use-secret-specs";
import { UnsavedChangesDialog } from "./unsaved-changes-dialog";

export const HOOK_EVENTS: HookEvent[] = [
  "conversation_start",
  "message_received",
  "response_generated",
  "response_sent",
];

export interface HookSettings {
  event: HookEvent;
  timeoutMs: number;
  position: number;
}

interface SettingsFieldProps {
  value: HookSettings;
  onChange: (next: HookSettings) => void;
  disabled?: boolean;
}

/** When the hook runs. */
export function HookEventField({ value, onChange, disabled = false }: SettingsFieldProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <Label>{t("hooks.event")}</Label>
      <Select
        value={value.event}
        disabled={disabled}
        onValueChange={(v) => onChange({ ...value, event: v as HookEvent })}
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
  );
}

/** How long the hook may take, and where it sits among the event's hooks. */
export function HookRunFields({ value, onChange, disabled = false }: SettingsFieldProps) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor="hook-timeout">{t("hooks.timeout")}</Label>
        <Input
          id="hook-timeout"
          type="number"
          min={1000}
          max={30000}
          step={1000}
          disabled={disabled}
          value={value.timeoutMs}
          onChange={(e) => onChange({ ...value, timeoutMs: Number(e.target.value) })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="hook-position">{t("hooks.position")}</Label>
        <Input
          id="hook-position"
          type="number"
          min={0}
          disabled={disabled}
          value={value.position}
          onChange={(e) => onChange({ ...value, position: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}

/** The keys one hook function declares. */
export function HookParamFields({
  specs,
  params,
}: {
  specs: readonly RequiredSecretSpec[];
  params: SecretSpecsForm;
}) {
  const { t } = useI18n();
  if (specs.length === 0) return <p className="text-sm text-muted-foreground">{t("hooks.paramsNone")}</p>;
  if (!params.canRead) {
    return (
      <>
        <p className="text-sm text-muted-foreground">{t("tools.paramsNoAccess")}</p>
        {specs.map((spec) => (
          <div key={spec.key} className="space-y-1">
            <p className="text-sm font-medium">{spec.label ?? humanizeSecretKey(spec.key)}</p>
            <p className="text-xs text-muted-foreground">{spec.description ?? t("tools.paramNoDescription")}</p>
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      {specs.map((spec) => (
        <SecretSpecField key={spec.key} spec={spec} form={params} />
      ))}
    </>
  );
}

export function StreamingWarning() {
  const { t } = useI18n();
  return (
    <p className="flex items-start gap-1.5 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{t("hooks.streamingWarning")}</span>
    </p>
  );
}

interface Props {
  hook: InstanceHook | null;
  /** The catalog entry of the hook's function, or null when the function is gone. */
  fn: HookFunctionInfo | null;
  specs: readonly RequiredSecretSpec[];
  params: SecretSpecsForm;
  /** Writes the hook's settings; the parameters are written by the sheet itself. */
  onSaveSettings: (hook: InstanceHook, settings: HookSettings) => Promise<void>;
  onDelete: (hook: InstanceHook) => void;
  onClose: () => void;
}

function settingsOf(hook: InstanceHook): HookSettings {
  return { event: hook.event, timeoutMs: hook.timeoutMs, position: hook.position };
}

/**
 * One hook, opened from its row: what its function does, when it runs, and the
 * keys it asks for. One Save writes both the settings and the keys; closing with
 * anything unsaved asks first.
 */
export function HookSheet({ hook, fn, specs, params, onSaveSettings, onDelete, onClose }: Props) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<HookSettings | null>(hook ? settingsOf(hook) : null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // A different hook opened (or the same one reloaded): start from what is stored.
  const [shownHook, setShownHook] = useState(hook);
  if (hook !== shownHook) {
    setShownHook(hook);
    setSettings(hook ? settingsOf(hook) : null);
  }

  const settingsDirty =
    hook !== null &&
    settings !== null &&
    (settings.event !== hook.event || settings.timeoutMs !== hook.timeoutMs || settings.position !== hook.position);
  const dirty = settingsDirty || params.dirty;

  const discard = () => {
    params.reset();
    setConfirmDiscard(false);
    onClose();
  };

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const save = async () => {
    if (!hook || !settings) return;
    setSaving(true);
    try {
      // The keys first: a hook moved to another event must find them already set.
      if (params.dirty) await params.save();
      if (settingsDirty) await onSaveSettings(hook, settings);
      toast.success(t("hooks.saved"));
      onClose();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("hooks.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const fnName = hook?.actionConfig.functionName ?? "";
  const named = fnName.trim().length > 0;

  return (
    <>
      <Sheet open={hook !== null} onOpenChange={(open) => !open && requestClose()}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
          {hook && settings && (
            <>
              <SheetHeader className="gap-2 border-b p-5 pr-12">
                <SheetTitle className={named ? "font-mono text-base font-medium" : "text-base font-medium"}>
                  {named ? fnName : t("hooks.unknownAction")}
                </SheetTitle>
                <SheetDescription>{fn?.description || t("hooks.dialogDescription")}</SheetDescription>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Badge variant="secondary">{t(`hooks.events.${hook.event}`)}</Badge>
                  {named && !fn && <Badge variant="destructive">{t("hooks.unknownFunction")}</Badge>}
                </div>
              </SheetHeader>

              <div className="flex-1 space-y-8 overflow-y-auto p-5">
                {fn?.mutatesResponse && <StreamingWarning />}

                <section className="space-y-4">
                  <h3 className="text-sm font-medium">{t("hooks.settings")}</h3>
                  <HookEventField value={settings} onChange={setSettings} />
                  <HookRunFields value={settings} onChange={setSettings} />
                </section>

                <section className="space-y-4">
                  <h3 className="text-sm font-medium">{t("hooks.params")}</h3>
                  <HookParamFields specs={specs} params={params} />
                </section>
              </div>

              <SheetFooter className="flex-row justify-between border-t p-4">
                <Button variant="ghost" className="text-destructive" onClick={() => onDelete(hook)}>
                  <Trash2 className="size-4" aria-hidden />
                  {t("common.delete")}
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={requestClose}>
                    {t("common.close")}
                  </Button>
                  <Button onClick={save} disabled={!dirty || saving}>
                    {saving ? t("common.saving") : t("common.save")}
                  </Button>
                </div>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <UnsavedChangesDialog open={confirmDiscard} onOpenChange={setConfirmDiscard} onDiscard={discard} />
    </>
  );
}
