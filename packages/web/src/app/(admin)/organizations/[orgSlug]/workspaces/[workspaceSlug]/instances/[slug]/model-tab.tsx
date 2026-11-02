// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { EMPTY_CELL, ListHead, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { StatusBadge } from "@/components/status-badge";
import { ListLoading, ListNoResults } from "@/components/list-states";
import { useListView } from "@/components/use-list-view";
import { api, isForbidden, type Instance, type ModelsResponse, type SecretStatus } from "@/lib/api";
import { useResource } from "@/hooks/use-resource";
import { useI18n } from "@/lib/i18n/context";
import { providerName } from "@/lib/provider-secrets";
import { ModelTaskSheet } from "./model-task-sheet";
import {
  MODEL_TASKS,
  REQUIRED_KEYS,
  STT_LABELS,
  TASK_HELP,
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
const NO_SECRETS: SecretStatus[] = [];

export function ModelTab({ instance, onUpdate, onConfigurationChanged }: Props) {
  const { t } = useI18n();
  // Independent reads: a refused keys read must not blank the model choices.
  const models = useResource(["models"], () => api.models.list());
  const secretsRead = useResource(["secrets", instance.slug], () => api.secrets.list(instance.slug));
  const modelsData: ModelsResponse | null = models.data ?? null;
  // The keys list the panel hands back after it writes one is newer than the read above.
  const [savedSecrets, setSavedSecrets] = useState<SecretStatus[] | null>(null);
  const secrets: SecretStatus[] = savedSecrets ?? secretsRead.data?.secrets ?? NO_SECRETS;
  // `agent.secret:read` is not everyone's: a reader without it is shown the
  // choices and no keys, and never told a key is missing that it cannot see.
  const canReadSecrets = !isForbidden(secretsRead.error);
  const loading = models.loading || secretsRead.loading;
  const [openTask, setOpenTask] = useState<ModelTask | null>(null);
  const [search, setSearch] = useState("");

  // A failed read other than a refusal is said once, when it arrives.
  const failed = models.error !== undefined || (secretsRead.error !== undefined && canReadSecrets);
  useEffect(() => {
    if (failed) toast.error(t("settings.tab.loadFailed"));
    // The failure is the trigger; `t` is read for the message only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);

  // The tasks are a fixed set in a fixed order (conversation, embedder, transcription).
  const visibleTasks = useListView(
    MODEL_TASKS,
    search,
    (task) => [t(TASK_TITLE[task]), t(TASK_HELP[task])],
    null,
  );

  if (loading) return <ListLoading className="" />;

  const choices = savedChoices(instance);
  const isConfigured = (key: string) => secrets.some((s) => s.key === key && s.configured);

  /** What a row says in its Provider and Model cells. */
  const describe = (task: ModelTask): { provider: string; model: string } => {
    switch (task) {
      case "chat":
        return {
          provider: providerName(choices.chatProvider) || t("settings.tab.systemDefault"),
          model:
            instance.model && instance.fastMode
              ? t("settings.tab.fastVariant", { model: instance.model })
              : instance.model || instance.effectiveModel || t("settings.tab.systemDefault"),
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
      return <StatusBadge tone="neutral">{t("modelTasks.notInUse")}</StatusBadge>;
    }
    const group = taskCredential(task, choices);
    if (!canReadSecrets || !group) return <span className="text-muted-foreground">{EMPTY_CELL}</span>;
    if (REQUIRED_KEYS[group].some((key) => !isConfigured(key))) {
      return <StatusBadge tone="negative">{t("settings.role.missing")}</StatusBadge>;
    }
    return <StatusBadge tone="positive">{t("settings.role.ready")}</StatusBadge>;
  };

  return (
    <>
      <div>
      <ListToolbar value={search} onChange={setSearch} />
      {visibleTasks.length === 0 ? (
        <ListNoResults />
      ) : (
      <ListTable>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <ListHead className="w-[30%]">{t("modelTasks.columnTask")}</ListHead>
            <ListHead className="hidden w-[20%] sm:table-cell">{t("settings.tab.provider")}</ListHead>
            <ListHead className="hidden md:table-cell">{t("settings.tab.model")}</ListHead>
            <ListHead className="w-36">{t("modelTasks.columnStatus")}</ListHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleTasks.map((task) => {
            const { provider, model } = describe(task);
            const title = t(TASK_TITLE[task]);
            return (
              <ListRow key={task} selected={openTask === task} onOpen={() => setOpenTask(task)}>
                <ListNameCell name={title} summary={t(TASK_HELP[task])} openLabel={t("modelTasks.open", { task: title })} onOpen={() => setOpenTask(task)} />
                <TableCell className="hidden truncate text-sm sm:table-cell">{provider}</TableCell>
                <TableCell className="hidden truncate font-mono text-xs md:table-cell" title={model}>
                  {model}
                </TableCell>
                <TableCell>{status(task)}</TableCell>
              </ListRow>
            );
          })}
        </TableBody>
      </ListTable>
      )}
      </div>

      <ModelTaskSheet
        task={openTask}
        instance={instance}
        modelsData={modelsData}
        secrets={secrets}
        canReadSecrets={canReadSecrets}
        onSecretsChanged={(next) => {
          setSavedSecrets(next);
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
