// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, isForbidden, type Instance, type ModelsResponse, type SecretStatus } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { providerName } from "@/lib/provider-secrets";
import { ModelTaskSheet } from "./model-task-sheet";
import {
  MODEL_TASKS,
  REQUIRED_KEYS,
  STT_LABELS,
  TASK_TITLE,
  savedChoices,
  taskCredential,
  taskInUse,
  type ModelTask,
} from "./model-tasks";

interface Props {
  instance: Instance;
  onUpdate: (instance: Instance) => void;
  /** After a save, so the status checks read the configuration again. */
  onConfigurationChanged?: () => void;
}

/**
 * The agent's Model section: one row per task it calls a provider for — the
 * conversation, the embedder and voice-note transcription — with the provider,
 * the model and whether its key is in place. A row opens the task in a side
 * panel, where the choice, its options and the key are saved together.
 */
export function ModelTab({ instance, onUpdate, onConfigurationChanged }: Props) {
  const { t } = useI18n();
  const [modelsData, setModelsData] = useState<ModelsResponse | null>(null);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  // `agent.secret:read` is not everyone's: a reader without it is shown the
  // choices and no keys, and never told a key is missing that it cannot see.
  const [canReadSecrets, setCanReadSecrets] = useState(true);
  const [loading, setLoading] = useState(true);
  const [openTask, setOpenTask] = useState<ModelTask | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Independent reads: a refused keys read must not blank the model choices.
    Promise.allSettled([api.secrets.list(instance.slug), api.models.list()])
      .then(([secretsRes, modelsRes]) => {
        if (cancelled) return;
        if (modelsRes.status === "fulfilled") setModelsData(modelsRes.value);
        else toast.error(t("settings.tab.loadFailed"));
        if (secretsRes.status === "fulfilled") setSecrets(secretsRes.value.secrets);
        else if (isForbidden(secretsRes.reason)) setCanReadSecrets(false);
        else toast.error(t("settings.tab.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` is read for a toast only: reading everything again because a
    // translation function changed identity would reset the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.slug]);

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-10 rounded-lg bg-muted" />
        <div className="h-32 rounded-lg bg-muted" />
      </div>
    );
  }

  const choices = savedChoices(instance);
  const isConfigured = (key: string) => secrets.some((s) => s.key === key && s.configured);

  /** What a row says in its Provider and Model cells. */
  const describe = (task: ModelTask): { provider: string; model: string } => {
    switch (task) {
      case "chat":
        return {
          provider: providerName(choices.chatProvider) || t("settings.tab.systemDefault"),
          model: instance.model || instance.effectiveModel || t("settings.tab.systemDefault"),
        };
      case "embed":
        return {
          provider: providerName(choices.embeddingProvider),
          model: instance.embeddingDim ? t("modelTasks.dimensions", { count: instance.embeddingDim }) : "—",
        };
      case "stt":
        return choices.sttProvider === "disabled"
          ? { provider: t("settings.tab.sttProviderDisabled"), model: "—" }
          : { provider: providerName(choices.sttProvider), model: STT_LABELS[choices.sttProvider] };
    }
  };

  /** Whether a task can run: only what can be known, never a guess. */
  const status = (task: ModelTask) => {
    if (!taskInUse(task, instance, choices.sttProvider)) {
      return <span className="text-xs text-muted-foreground">{t("modelTasks.notInUse")}</span>;
    }
    const group = taskCredential(task, choices);
    if (!canReadSecrets || !group) return <span className="text-xs text-muted-foreground">—</span>;
    if (REQUIRED_KEYS[group].some((key) => !isConfigured(key))) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
          <AlertTriangle className="size-3.5" aria-hidden />
          {t("settings.role.missing")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <Check className="size-3.5" aria-hidden />
        {t("settings.role.ready")}
      </span>
    );
  };

  return (
    <>
      <Table flush className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[30%]">{t("modelTasks.columnTask")}</TableHead>
            <TableHead className="hidden w-[20%] sm:table-cell">{t("settings.tab.provider")}</TableHead>
            <TableHead className="hidden md:table-cell">{t("settings.tab.model")}</TableHead>
            <TableHead className="w-36">{t("modelTasks.columnStatus")}</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">{t("tools.columnActions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {MODEL_TASKS.map((task) => {
            const { provider, model } = describe(task);
            const title = t(TASK_TITLE[task]);
            return (
              <TableRow
                key={task}
                data-task={task}
                data-state={openTask === task ? "selected" : undefined}
                className="group cursor-pointer border-0"
                onClick={() => setOpenTask(task)}
              >
                <TableCell className="py-2.5">
                  <button
                    type="button"
                    className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                    aria-label={t("modelTasks.open", { task: title })}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenTask(task);
                    }}
                  >
                    {title}
                  </button>
                </TableCell>
                <TableCell className="hidden truncate text-sm sm:table-cell">{provider}</TableCell>
                <TableCell className="hidden truncate font-mono text-xs md:table-cell" title={model}>
                  {model}
                </TableCell>
                <TableCell>{status(task)}</TableCell>
                <TableCell>
                  <ChevronRight
                    className="ml-auto size-4 text-muted-foreground/60 transition-colors group-hover:text-foreground"
                    aria-hidden
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <ModelTaskSheet
        task={openTask}
        instance={instance}
        modelsData={modelsData}
        secrets={secrets}
        canReadSecrets={canReadSecrets}
        onSecretsChanged={(next) => {
          setSecrets(next);
          onConfigurationChanged?.();
        }}
        onSaved={async (updated) => {
          if (updated) onUpdate(updated);
          setOpenTask(null);
          onConfigurationChanged?.();
        }}
        onClose={() => setOpenTask(null)}
      />
    </>
  );
}
