// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
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
import { SecretField } from "@/components/instance-secret/secret-field";
import { ReadableField } from "@/components/instance-secret/secret-spec-field";
import { UnsavedChangesDialog } from "@/components/unsaved-changes-dialog";
import { api, getUserErrorMessage, type Instance, type ModelsResponse, type SecretStatus } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { BRAND_NAMES, providerName } from "@/lib/provider-secrets";
import { ModelCatalogDialog } from "./model-catalog-dialog";
import {
  MODEL_TASKS,
  REASONING_LEVEL_LABELS,
  REQUIRED_KEYS,
  STT_LABELS,
  TASK_HELP,
  TASK_TITLE,
  credentialSection,
  savedChoices,
  taskCredential,
  taskInUse,
  type ModelTask,
  type STTProvider,
} from "./model-tasks";

interface Props {
  /** The task the sheet is open on; null = closed. */
  task: ModelTask | null;
  instance: Instance;
  modelsData: ModelsResponse | null;
  secrets: SecretStatus[];
  /** False when the caller may not read the agent's keys: they are neither shown nor asked for. */
  canReadSecrets: boolean;
  /** After a key was removed: the agent's keys as they are now. */
  onSecretsChanged: (secrets: SecretStatus[]) => void;
  /** After a save; the updated agent when the save changed it. */
  onSaved: (updated: Instance | null) => Promise<void>;
  onClose: () => void;
}

/** Everything a panel can change, as it was when it opened and as it is now. */
interface Draft {
  provider: string;
  model: string;
  thinkingEnabled: boolean;
  thinkingLevel: string;
  temperature: number | null;
  cacheEnabled: boolean;
  cacheTtl: string;
  embeddingProvider: string;
  sttProvider: STTProvider;
  /** Keys typed in the panel, by secret key; empty = keep the stored one. */
  keys: Record<string, string>;
}

const brand = (p: string) => BRAND_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

function draftOf(instance: Instance): Draft {
  return {
    provider: instance.provider ?? "",
    model: instance.model ?? "",
    thinkingEnabled: instance.thinkingEnabled,
    thinkingLevel: instance.thinkingLevel ?? "medium",
    temperature: instance.temperature ?? null,
    cacheEnabled: instance.cacheEnabled,
    cacheTtl: instance.cacheTtl,
    embeddingProvider: instance.embeddingProvider ?? "openai",
    sttProvider: (instance.sttProvider as STTProvider | null) ?? "openai",
    keys: {},
  };
}

/**
 * One task of the agent in a side panel: the provider, the model and its
 * options, and the key that provider reads — one draft, saved by the footer's
 * button, so a provider is never saved without the key it needs.
 */
export function ModelTaskSheet({
  task,
  instance,
  modelsData,
  secrets,
  canReadSecrets,
  onSecretsChanged,
  onSaved,
  onClose,
}: Props) {
  const { t } = useI18n();
  const [initial, setInitial] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // The draft starts from what is saved when the sheet opens on a task, and
  // only then: "changed" means "differs from this", and a read of the page's
  // data while the panel is open does not wipe what is being typed.
  useEffect(() => {
    if (!task) return;
    const start = draftOf(instance);
    setInitial(start);
    setDraft(start);
    setVisible({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  if (!task || !draft || !initial) {
    return <Sheet open={false} />;
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setKey = (key: string, value: string) => set({ keys: { ...draft.keys, [key]: value } });

  // ── The chat model's catalog and what the chosen model supports ─────────
  const providerNames = modelsData ? Object.keys(modelsData.providers) : [];
  const availableModels =
    draft.provider && modelsData?.providers[draft.provider] ? modelsData.providers[draft.provider].models : [];
  // No model pinned ("System default"): mirror the engine's fallback to the standard tier.
  const selectedModelInfo =
    availableModels.find((m) => m.id === draft.model) ??
    (draft.model === "" ? availableModels.find((m) => m.tier === "standard") : undefined);
  const canEnableThinking = !!selectedModelInfo?.supportsThinking;
  // gpt-oss & co. reason on every call: the toggle is locked on, and saved on
  // so the engine applies the effort level.
  const alwaysOnThinking = !!selectedModelInfo?.reasoningAlwaysOn;
  const thinkingToPersist = alwaysOnThinking || draft.thinkingEnabled;
  const effectiveThinkingEnabled = thinkingToPersist && canEnableThinking;
  const canSetTemperature = effectiveThinkingEnabled
    ? !!selectedModelInfo?.supportsTemperatureWithThinking
    : !!selectedModelInfo?.supportsTemperature;
  // The agent's current embedder stays listed even when the server stops offering it.
  const embedderOptions = Array.from(
    new Set([...(modelsData?.embedders ?? []).map((e) => e.id), instance.embeddingProvider ?? "openai"]),
  );

  // ── What changed ─────────────────────────────────────────────────────────
  const changed = <K extends keyof Draft>(key: K) => JSON.stringify(draft[key]) !== JSON.stringify(initial[key]);
  const instanceDirty =
    task === "chat"
      ? (["provider", "model", "thinkingEnabled", "thinkingLevel", "temperature", "cacheEnabled", "cacheTtl"] as const).some(changed)
      : task === "embed"
        ? changed("embeddingProvider")
        : changed("sttProvider");

  // ── The key the task's provider reads, under the draft ──────────────────
  const choices = {
    ...savedChoices(instance),
    ...(task === "chat" ? { chatProvider: draft.provider || instance.effectiveProvider || "" } : {}),
    ...(task === "embed" ? { embeddingProvider: draft.embeddingProvider } : {}),
    ...(task === "stt" ? { sttProvider: draft.sttProvider } : {}),
  };
  const group = taskCredential(task, choices);
  const section = group ? credentialSection(group) : null;
  // Keys typed for another provider are dropped with it: only this provider's are saved.
  const typedKeys = Object.entries(draft.keys).filter(
    ([key, value]) => value !== "" && (section?.fields.some((field) => field.key === key) ?? false),
  );
  const dirty = instanceDirty || typedKeys.length > 0;
  const isConfigured = (key: string) => secrets.some((s) => s.key === key && s.configured);
  const inUse = taskInUse(task, instance, draft.sttProvider);
  const keyMissing =
    group !== null &&
    canReadSecrets &&
    inUse &&
    REQUIRED_KEYS[group].some((key) => !isConfigured(key) && !(draft.keys[key] ?? "").trim());
  // The other tasks that read the same keys: a change here reaches them too.
  const sharedWith = MODEL_TASKS.filter(
    (other) => other !== task && group !== null && taskCredential(other, savedChoices(instance)) === group,
  );

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const perform = async (confirmWipe: boolean) => {
    setSaving(true);
    try {
      // The keys first: a provider saved without the key it reads fails at the first message.
      if (typedKeys.length > 0) {
        const res = await api.secrets.set(
          instance.slug,
          typedKeys.map(([key, value]) => ({ key, value })),
        );
        onSecretsChanged(res.secrets);
      }
      let updated: Instance | null = null;
      if (instanceDirty) {
        const body =
          task === "chat"
            ? {
                provider: draft.provider || null,
                model: draft.model || null,
                thinkingEnabled: thinkingToPersist,
                thinkingLevel: draft.thinkingLevel,
                temperature: canSetTemperature ? draft.temperature : null,
                cacheEnabled: draft.cacheEnabled,
                cacheTtl: draft.cacheTtl,
              }
            : task === "embed"
              ? { embeddingProvider: draft.embeddingProvider, confirmWipe }
              : { sttProvider: draft.sttProvider };
        updated = (await api.instances.update(instance.slug, body)).instance;
      }
      toast.success(t("settings.tab.saved"));
      await onSaved(updated);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    // Switching the embedder abandons the old vector space: memories and
    // knowledge are wiped, not converted, so the loss is confirmed first.
    if (task === "embed" && instanceDirty) setWipeOpen(true);
    else void perform(false);
  };

  const removeKey = async (key: string) => {
    try {
      await api.secrets.delete(instance.slug, key);
      onSecretsChanged(secrets.filter((s) => s.key !== key));
      toast.success(t("common.deleted"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("settings.tab.saveFailed")));
    }
  };

  const field = (id: string, label: string, control: ReactNode, help?: ReactNode) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {control}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );

  const choice = (
    id: string,
    label: string,
    value: string,
    entries: readonly (readonly [string, string])[],
    onChange: (value: string) => void,
  ) =>
    field(
      id,
      label,
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {entries.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );

  /** The task's own choices: provider and model. */
  const taskChoices =
    task === "chat" ? (
      <>
        {modelsData && (
          <div className="flex justify-end">
            <ModelCatalogDialog
              modelsData={modelsData}
              providerNames={providerNames}
              selectedProvider={draft.provider}
              selectedModel={draft.model}
              onSelect={(p, m) => set({ provider: p, model: m })}
            />
          </div>
        )}
        {field(
          "task-provider",
          t("settings.tab.provider"),
          <Select value={draft.provider} onValueChange={(value) => set({ provider: value, model: "" })}>
            <SelectTrigger id="task-provider" className="w-full">
              <SelectValue placeholder={t("settings.tab.systemDefault")} />
            </SelectTrigger>
            <SelectContent>
              {providerNames.map((p) => (
                <SelectItem key={p} value={p}>
                  {brand(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>,
        )}
        {field(
          "task-model",
          t("settings.tab.model"),
          <Select value={draft.model} onValueChange={(value) => set({ model: value })} disabled={!draft.provider}>
            <SelectTrigger id="task-model" className="w-full">
              <SelectValue placeholder={t("settings.tab.systemDefault")} />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>,
        )}
      </>
    ) : task === "embed" ? (
      choice(
        "task-embedder",
        t("settings.tab.embedder"),
        draft.embeddingProvider,
        embedderOptions.map((id) => [id, brand(id)] as const),
        (value) => set({ embeddingProvider: value }),
      )
    ) : (
      choice(
        "task-stt",
        t("settings.tab.sttProvider"),
        draft.sttProvider,
        [...Object.entries(STT_LABELS), ["disabled", t("settings.tab.sttProviderDisabled")] as const],
        (value) => set({ sttProvider: value as STTProvider }),
      )
    );

  /** The key the chosen provider reads, under the choice it serves. */
  const credentials = (() => {
    if (task === "stt" && draft.sttProvider === "disabled") return null;
    if (!group || !section) {
      return <p className="text-xs text-muted-foreground">{t("settings.tab.credentialElsewhere")}</p>;
    }
    return (
      <section className="space-y-4 border-t pt-6">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {t("modelTasks.credentials", { provider: group === "aws" ? "AWS" : providerName(group) })}
          </h3>
          {sharedWith.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("settings.tab.credentialAlsoUsedBy", { roles: sharedWith.map((other) => t(TASK_TITLE[other])).join(", ") })}
            </p>
          )}
        </div>
        {!canReadSecrets ? (
          <p className="text-sm text-muted-foreground">{t("settings.tab.credentialNoAccess")}</p>
        ) : (
          <>
            {section.fields.map((secret) => {
              const configured = isConfigured(secret.key);
              const shared = {
                label: t(secret.labelKey),
                value: draft.keys[secret.key] ?? "",
                onChange: (value: string) => setKey(secret.key, value),
                configured,
                placeholder: configured
                  ? t("settings.tab.keyPlaceholderSet")
                  : t(secret.placeholderKey ?? "settings.tab.keyPlaceholder"),
                onRemove: configured ? () => void removeKey(secret.key) : undefined,
              };
              // A region is config, not a credential — never masked.
              return secret.sensitive === false ? (
                <ReadableField key={secret.key} {...shared} />
              ) : (
                <SecretField
                  key={secret.key}
                  {...shared}
                  visible={visible[secret.key] ?? false}
                  onToggleVisibility={() => setVisible((prev) => ({ ...prev, [secret.key]: !prev[secret.key] }))}
                />
              );
            })}
            {group === "aws" && (
              <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p className="text-sm">{t("settings.tab.awsFallbackNote")}</p>
              </div>
            )}
            {keyMissing && <p className="text-xs text-warning">{t("modelTasks.keyRequired")}</p>}
          </>
        )}
      </section>
    );
  })();

  const tuning =
    task === "chat" ? (
      <section className="space-y-5 border-t pt-6">
        <h3 className="text-sm font-medium">{t("settings.tab.modelTuning")}</h3>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="task-thinking">{t("settings.tab.thinking")}</Label>
            <p className="text-xs text-muted-foreground">
              {alwaysOnThinking
                ? t("settings.tab.thinkingAlwaysOn")
                : canEnableThinking
                  ? t("settings.tab.thinkingHelp")
                  : t("settings.tab.thinkingUnavailable")}
            </p>
          </div>
          <Switch
            id="task-thinking"
            checked={alwaysOnThinking || draft.thinkingEnabled}
            disabled={!canEnableThinking || alwaysOnThinking}
            onCheckedChange={(checked) => set({ thinkingEnabled: checked })}
          />
        </div>
        {effectiveThinkingEnabled && (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="task-reasoning">{t("settings.tab.reasoningLevel")}</Label>
              <p className="text-xs text-muted-foreground">{t("settings.tab.reasoningLevelHelp")}</p>
            </div>
            <Select value={draft.thinkingLevel} onValueChange={(value) => set({ thinkingLevel: value })}>
              <SelectTrigger id="task-reasoning" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(selectedModelInfo?.reasoningLevels?.length ? selectedModelInfo.reasoningLevels : ["low", "medium", "high"]).map((lvl) => (
                  <SelectItem key={lvl} value={lvl}>
                    {REASONING_LEVEL_LABELS[lvl] ?? lvl}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="temperature">{t("settings.temperature.label")}</Label>
          <Input
            id="temperature"
            type="number"
            min={0}
            max={2}
            step={0.1}
            disabled={!canSetTemperature}
            value={draft.temperature ?? ""}
            placeholder={t("settings.temperature.placeholder")}
            onChange={(e) => set({ temperature: e.target.value === "" ? null : Number(e.target.value) })}
          />
          {!canSetTemperature && (
            <p className="text-xs text-muted-foreground">
              {!selectedModelInfo?.supportsTemperature
                ? t("settings.temperature.unsupportedReasoningHint")
                : t("settings.temperature.unsupportedThinkingHint")}
            </p>
          )}
        </div>
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="task-cache">{t("settings.tab.cache")}</Label>
              <p className="text-xs text-muted-foreground">
                {draft.provider === "openai"
                  ? t("settings.tab.cacheAutomaticHelp")
                  : draft.provider === "nebius"
                    ? t("settings.tab.cacheNebiusHelp")
                    : t("settings.tab.cacheHelp")}
              </p>
            </div>
            <Switch
              id="task-cache"
              checked={draft.provider === "openai" || draft.provider === "nebius" ? true : draft.cacheEnabled}
              onCheckedChange={(checked) => set({ cacheEnabled: checked })}
              disabled={draft.provider === "openai" || draft.provider === "nebius"}
            />
          </div>
          {(draft.provider === "anthropic" || draft.provider === "bedrock") && draft.cacheEnabled && (
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="task-cache-ttl" className="text-sm">
                {t("settings.tab.cacheTtl")}
              </Label>
              {draft.provider === "anthropic" ? (
                <Select value={draft.cacheTtl} onValueChange={(value) => set({ cacheTtl: value })}>
                  <SelectTrigger id="task-cache-ttl" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5m">{t("settings.tab.cacheTtl5m")}</SelectItem>
                    <SelectItem value="1h">{t("settings.tab.cacheTtl1h")}</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-xs text-muted-foreground">{t("settings.tab.cacheTtlBedrock")}</span>
              )}
            </div>
          )}
        </div>
      </section>
    ) : null;

  return (
    <>
      <Sheet open onOpenChange={(open) => !open && requestClose()}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
          <SheetHeader className="gap-1.5 border-b p-5 pr-12">
            <SheetTitle className="text-base">{t(TASK_TITLE[task])}</SheetTitle>
            <SheetDescription>{t(TASK_HELP[task])}</SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
            {taskChoices}
            {credentials}
            {tuning}
          </div>

          <SheetFooter className="flex-row justify-end gap-2 border-t p-4">
            <Button variant="outline" onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save} disabled={!dirty || saving || keyMissing}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <AlertDialog open={wipeOpen} onOpenChange={setWipeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("memory.wipe.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("memory.wipe.body", { provider: brand(draft.embeddingProvider) })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setWipeOpen(false);
                void perform(true);
              }}
            >
              {t("memory.wipe.primary")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <UnsavedChangesDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        onDiscard={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
    </>
  );
}
