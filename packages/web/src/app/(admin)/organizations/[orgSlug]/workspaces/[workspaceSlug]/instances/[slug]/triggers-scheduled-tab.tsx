// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  AlertCircle,
  Loader2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DrawerDeleteButton, ListDrawer } from "@/components/list-drawer";
import { ListEmpty, ListLoading } from "@/components/list-states";
import { SwitchList } from "@/components/switch-list";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { EMPTY_CELL } from "@/components/list-table";
import { api, getUserErrorMessage, type ScheduledTask, type ScheduledTaskSchedule } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";
import { useFormat } from "@/lib/use-format";
import { useResource } from "@/hooks/use-resource";
import { LoadFailed } from "@/components/ui/load-failed";
import { SectionActions } from "./section-actions";

interface Props {
  slug: string;
}

type ScheduleType = "cron" | "interval" | "one-shot";

type OutboundChannelType = "" | "telegram" | "slack" | "whatsapp";

interface TaskForm {
  name: string;
  description: string;
  prompt: string;
  scheduleType: ScheduleType;
  cronExpression: string;
  timezone: string;
  intervalValue: string;
  intervalUnit: "m" | "h" | "d";
  runAt: string;
  deleteAfterRun: boolean;
  outboundChannel: OutboundChannelType;
  outboundTarget: string;
  keepHistory: boolean;
}

const EMPTY_FORM: TaskForm = {
  name: "",
  description: "",
  prompt: "",
  scheduleType: "cron",
  cronExpression: "",
  timezone: "UTC",
  intervalValue: "",
  intervalUnit: "h",
  runAt: "",
  deleteAfterRun: false,
  outboundChannel: "",
  outboundTarget: "",
  keepHistory: false,
};

function buildSchedule(form: TaskForm): ScheduledTaskSchedule {
  switch (form.scheduleType) {
    case "cron":
      return {
        type: "cron",
        expression: form.cronExpression,
        timezone: form.timezone || undefined,
      };
    case "interval": {
      const interval = parseInt(form.intervalValue, 10);
      if (!form.intervalValue || isNaN(interval) || interval <= 0) {
        throw new Error("INVALID_INTERVAL");
      }
      const multipliers = { m: 60_000, h: 3_600_000, d: 86_400_000 };
      return {
        type: "interval",
        everyMs: interval * multipliers[form.intervalUnit],
      };
    }
    case "one-shot":
      return { type: "one-shot", runAt: new Date(form.runAt).toISOString() };
  }
}

function formFromTask(task: ScheduledTask): TaskForm {
  const s = task.schedule;
  const base = {
    name: task.name,
    description: task.description ?? "",
    prompt: task.prompt,
    deleteAfterRun: task.deleteAfterRun,
    outboundChannel: (task.outboundChannel ?? "") as OutboundChannelType,
    outboundTarget: task.outboundTarget ?? "",
    keepHistory: task.keepHistory ?? false,
    cronExpression: "",
    timezone: "UTC",
    intervalValue: "",
    intervalUnit: "h" as const,
    runAt: "",
  };

  if (s.type === "cron") {
    return { ...base, scheduleType: "cron", cronExpression: s.expression ?? "", timezone: s.timezone ?? "UTC" };
  }
  if (s.type === "interval") {
    const ms = s.everyMs ?? 3_600_000;
    let unit: "m" | "h" | "d" = "m";
    let value = ms / 60_000;
    if (ms >= 86_400_000 && ms % 86_400_000 === 0) { unit = "d"; value = ms / 86_400_000; }
    else if (ms >= 3_600_000 && ms % 3_600_000 === 0) { unit = "h"; value = ms / 3_600_000; }
    return { ...base, scheduleType: "interval", intervalValue: String(value), intervalUnit: unit };
  }
  // one-shot
  const runAt = s.runAt ? new Date(s.runAt).toISOString().slice(0, 16) : "";
  return { ...base, scheduleType: "one-shot", runAt };
}

/** The task's state, as the one status badge every list uses. */
function TaskStatus({ task, t }: { task: ScheduledTask; t: (key: TranslationKey) => string }) {
  return <StatusBadge tone={statusTone(task)}>{statusLabel(task, t)}</StatusBadge>;
}

function statusTone(task: ScheduledTask): StatusTone {
  if (!task.enabled) return task.consecutiveErrors >= 5 ? "negative" : "neutral";
  if (task.lastRunStatus === "running") return "neutral";
  if (task.lastRunStatus === "error") return "negative";
  return "positive";
}

/** The status badge's text, for the search to match on it. */
function statusLabel(task: ScheduledTask, t: (key: TranslationKey) => string): string {
  if (!task.enabled) return t(task.consecutiveErrors >= 5 ? "scheduledTasks.statusAutoDisabled" : "scheduledTasks.statusPaused");
  if (task.lastRunStatus === "running") return t("scheduledTasks.statusRunning");
  if (task.lastRunStatus === "error") return t("scheduledTasks.statusError");
  return t("scheduledTasks.statusActive");
}

const NO_TASKS: ScheduledTask[] = [];

export function TriggersScheduledTab({ slug }: Props) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { data, error, loading, reload: loadTasks } = useResource(["scheduled-tasks", slug], () => api.scheduledTasks.list(slug));
  const tasks = data?.tasks ?? NO_TASKS;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (task: ScheduledTask) => {
    setEditingId(task.id);
    setForm(formFromTask(task));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name || !form.prompt) {
      toast.error(t("scheduledTasks.validation.required"));
      return;
    }
    setSaving(true);
    try {
      let schedule: ScheduledTaskSchedule;
      try {
        schedule = buildSchedule(form);
      } catch (e) {
        if (e instanceof Error && e.message === "INVALID_INTERVAL") {
          toast.error(t("triggers.scheduled.invalidInterval"));
          setSaving(false);
          return;
        }
        throw e;
      }
      const outboundChannel = form.outboundChannel || null;
      const outboundTarget = form.outboundChannel ? form.outboundTarget : null;

      if (editingId) {
        await api.scheduledTasks.update(slug, editingId, {
          name: form.name,
          description: form.description || undefined,
          prompt: form.prompt,
          schedule,
          deleteAfterRun: form.deleteAfterRun,
          outboundChannel,
          outboundTarget,
          keepHistory: form.keepHistory,
        });
        toast.success(t("scheduledTasks.updated"));
      } else {
        await api.scheduledTasks.create(slug, {
          name: form.name,
          prompt: form.prompt,
          schedule,
          description: form.description || undefined,
          deleteAfterRun: form.deleteAfterRun,
          outboundChannel,
          outboundTarget,
          keepHistory: form.keepHistory,
        });
        toast.success(t("scheduledTasks.created"));
      }
      setDialogOpen(false);
      loadTasks();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("scheduledTasks.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (task: ScheduledTask, enabled: boolean) => {
    try {
      await api.scheduledTasks.update(slug, task.id, { enabled });
      await loadTasks();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("scheduledTasks.toggleFailed")));
      throw err;
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.scheduledTasks.delete(slug, id);
      toast.success(t("scheduledTasks.deleted"));
      setDialogOpen(false);
      loadTasks();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("scheduledTasks.deleteFailed")));
    }
  };

  const handleRunNow = async (task: ScheduledTask) => {
    try {
      const res = await api.scheduledTasks.run(slug, task.id);
      toast.success(res.message);
      setTimeout(loadTasks, 2000);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("scheduledTasks.runFailed")));
    }
  };

  const editingTask = editingId ? tasks.find((task) => task.id === editingId) ?? null : null;

  if (error && data === undefined) return <LoadFailed message={t("scheduledTasks.loadFailed")} onRetry={loadTasks} />;

  if (loading && data === undefined) return <ListLoading className="" />;

  return (
    <div className="space-y-6">
      <SectionActions>
        <Button onClick={openCreate} size="sm">
          <Plus className="mr-1 size-4" />
          {t("scheduledTasks.newTask")}
        </Button>
      </SectionActions>

      {tasks.length === 0 ? (
        <ListEmpty className="mt-8" title={t("scheduledTasks.empty")} />
      ) : (
        <SwitchList
          rows={tasks}
          rowKey={(task) => task.id}
          name={(task) => task.name}
          nameHeader={t("scheduledTasks.col.name")}
          summary={(task) => task.description || undefined}
          searchText={(task) => [task.scheduleHuman, task.outboundChannel, statusLabel(task, t)]}
          columns={[
            {
              header: t("scheduledTasks.col.schedule"),
              className: "w-40",
              cell: (task) => <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{task.scheduleHuman}</code>,
            },
            {
              header: t("scheduledTasks.col.channel"),
              className: "w-32",
              cell: (task) =>
                task.outboundChannel ? (
                  <Badge variant="secondary">{task.outboundChannel}</Badge>
                ) : (
                  <span className="text-muted-foreground">{EMPTY_CELL}</span>
                ),
            },
            {
              header: t("scheduledTasks.col.status"),
              className: "w-40",
              cell: (task) => (
                <>
                  <TaskStatus task={task} t={t} />
                  {task.lastError && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertCircle className="ml-1 inline size-3.5 text-destructive" />
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs text-xs">
                        {task.lastError}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </>
              ),
            },
            { header: t("scheduledTasks.col.nextRun"), className: "w-52", nowrap: true, cell: (task) => fmt.dateTime(task.nextRunAt) || EMPTY_CELL },
            { header: t("scheduledTasks.col.lastRun"), className: "w-52", nowrap: true, cell: (task) => fmt.dateTime(task.lastRunAt) || EMPTY_CELL },
          ]}
          isOn={(task) => task.enabled}
          onToggle={handleToggle}
          switchLabel={(task) => t("common.activeNamed", { name: task.name })}
          onOpen={openEdit}
          selectedKey={dialogOpen ? editingId : null}
        />
      )}

      {/* Create / edit drawer. Running now and deleting a task live here, not on the row. */}
      <ListDrawer
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingTask ? editingTask.name : t("scheduledTasks.createTitle")}
        description={editingTask ? editingTask.scheduleHuman : t("scheduledTasks.dialogDescription")}
        destructive={editingTask && <DrawerDeleteButton onClick={() => setDeleting(editingTask)} />}
        actions={
          editingTask && (
            <Button variant="outline" onClick={() => handleRunNow(editingTask)}>
              <RotateCcw className="size-4" aria-hidden />
              {t("scheduledTasks.runNow")}
            </Button>
          )
        }
        primary={
          <Button onClick={handleSave} disabled={saving || !form.name.trim() || !form.prompt.trim()}>
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            {editingId ? t("common.save") : t("common.add")}
          </Button>
        }
      >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("scheduledTasks.form.name")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Daily briefing"
              />
            </div>

            <div className="space-y-2">
              <Label>{t("scheduledTasks.form.description")}</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={t("scheduledTasks.form.descriptionPlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Label>{t("scheduledTasks.form.prompt")}</Label>
              <Textarea
                value={form.prompt}
                onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                placeholder={t("scheduledTasks.form.promptPlaceholder")}
                rows={3}
                className="max-h-48 overflow-y-auto"
              />
            </div>

            <div className="space-y-2">
              <Label>{t("scheduledTasks.form.scheduleType")}</Label>
              <Select
                value={form.scheduleType}
                onValueChange={(v) => setForm((f) => ({ ...f, scheduleType: v as ScheduleType }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cron">Cron</SelectItem>
                  <SelectItem value="interval">{t("scheduledTasks.form.interval")}</SelectItem>
                  <SelectItem value="one-shot">One-shot</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.scheduleType === "cron" && (
              <>
                <div className="space-y-2">
                  <Label>{t("scheduledTasks.form.cronExpression")}</Label>
                  <Input
                    value={form.cronExpression}
                    onChange={(e) => setForm((f) => ({ ...f, cronExpression: e.target.value }))}
                    placeholder="0 9 * * 1-5"
                  />
                  <p className="text-xs text-muted-foreground">{t("scheduledTasks.form.cronHelp")}</p>
                </div>
                <div className="space-y-2">
                  <Label>{t("scheduledTasks.form.timezone")}</Label>
                  <Input
                    value={form.timezone}
                    onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                    placeholder="UTC"
                  />
                </div>
              </>
            )}

            {form.scheduleType === "interval" && (
              <div className="flex gap-2">
                <div className="flex-1 space-y-2">
                  <Label>{t("scheduledTasks.form.every")}</Label>
                  <Input
                    type="number"
                    min="1"
                    value={form.intervalValue}
                    onChange={(e) => setForm((f) => ({ ...f, intervalValue: e.target.value }))}
                    placeholder="2"
                  />
                </div>
                <div className="w-28 space-y-2">
                  <Label>{t("scheduledTasks.form.unit")}</Label>
                  <Select
                    value={form.intervalUnit}
                    onValueChange={(v) => setForm((f) => ({ ...f, intervalUnit: v as "m" | "h" | "d" }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="m">{t("scheduledTasks.form.minutes")}</SelectItem>
                      <SelectItem value="h">{t("scheduledTasks.form.hours")}</SelectItem>
                      <SelectItem value="d">{t("scheduledTasks.form.days")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {form.scheduleType === "one-shot" && (
              <div className="space-y-2">
                <Label>{t("scheduledTasks.form.runAt")}</Label>
                <Input
                  type="datetime-local"
                  value={form.runAt}
                  onChange={(e) => setForm((f) => ({ ...f, runAt: e.target.value }))}
                />
                <div className="flex items-center gap-2 pt-1">
                  <Switch
                    checked={form.deleteAfterRun}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, deleteAfterRun: v }))}
                  />
                  <Label className="text-sm font-normal">{t("scheduledTasks.form.deleteAfterRun")}</Label>
                </div>
              </div>
            )}

            {/* Output channel */}
            <div className="space-y-2 border-t pt-4">
              <Label>{t("scheduledTasks.form.outboundChannel")}</Label>
              <Select
                value={form.outboundChannel || "none"}
                onValueChange={(v) => setForm((f) => ({ ...f, outboundChannel: (v === "none" ? "" : v) as OutboundChannelType }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("scheduledTasks.form.noChannel")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("scheduledTasks.form.noChannel")}</SelectItem>
                  <SelectItem value="telegram">Telegram</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("scheduledTasks.form.outboundChannelHelp")}</p>
            </div>

            {form.outboundChannel && (
              <div className="space-y-2">
                <Label>{t("scheduledTasks.form.outboundTarget")}</Label>
                <Input
                  value={form.outboundTarget}
                  onChange={(e) => setForm((f) => ({ ...f, outboundTarget: e.target.value }))}
                  placeholder={t("scheduledTasks.form.outboundTargetPlaceholder")}
                />
              </div>
            )}

            <div className="flex items-center gap-2 border-t pt-4">
              <Switch
                checked={form.keepHistory}
                onCheckedChange={(v) => setForm((f) => ({ ...f, keepHistory: v }))}
              />
              <div>
                <Label className="text-sm font-normal">{t("scheduledTasks.form.keepHistory")}</Label>
                <p className="text-xs text-muted-foreground">{t("scheduledTasks.form.keepHistoryHelp")}</p>
              </div>
            </div>
          </div>

      </ListDrawer>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("scheduledTasks.deleteTitle")}
        description={t("scheduledTasks.deleteDescription", { name: deleting?.name ?? "" })}
        confirmLabel={t("common.delete")}
        onConfirm={() => {
          if (deleting) void handleDelete(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
