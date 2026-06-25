// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Play,
  Pause,
  Clock,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Pencil,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, getUserErrorMessage, type ScheduledTask, type ScheduledTaskSchedule } from "@/lib/api";
import { parseUTC } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

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

function StatusBadge({ task, t }: { task: ScheduledTask; t: (key: TranslationKey) => string }) {
  if (!task.enabled) {
    if (task.consecutiveErrors >= 5) {
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="size-3" />
          {t("scheduledTasks.statusAutoDisabled")}
        </Badge>
      );
    }
    return <Badge variant="secondary">{t("scheduledTasks.statusPaused")}</Badge>;
  }
  if (task.lastRunStatus === "running") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="size-3 animate-spin" />
        {t("scheduledTasks.statusRunning")}
      </Badge>
    );
  }
  if (task.lastRunStatus === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="size-3" />
        {t("scheduledTasks.statusError")}
      </Badge>
    );
  }
  return (
    <Badge variant="default" className="gap-1">
      <CheckCircle2 className="size-3" />
      {t("scheduledTasks.statusActive")}
    </Badge>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return parseUTC(iso).toLocaleString();
}

export function TriggersScheduledTab({ slug }: Props) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const loadTasks = useCallback(async () => {
    try {
      const res = await api.scheduledTasks.list(slug);
      setTasks(res.tasks);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("scheduledTasks.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

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

  const handleToggle = async (task: ScheduledTask) => {
    try {
      await api.scheduledTasks.update(slug, task.id, { enabled: !task.enabled });
      loadTasks();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("scheduledTasks.toggleFailed")));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.scheduledTasks.delete(slug, id);
      toast.success(t("scheduledTasks.deleted"));
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
        <div>
          <h3 className="text-lg font-medium">{t("scheduledTasks.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("scheduledTasks.description")}</p>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="mr-1 size-4" />
          {t("scheduledTasks.newTask")}
        </Button>
      </div>

      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          <Clock className="mx-auto mb-2 size-8" />
          <p>{t("scheduledTasks.empty")}</p>
        </div>
      ) : (
        <TooltipProvider>
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("scheduledTasks.col.name")}</TableHead>
                <TableHead>{t("scheduledTasks.col.schedule")}</TableHead>
                <TableHead>{t("scheduledTasks.col.channel")}</TableHead>
                <TableHead>{t("scheduledTasks.col.status")}</TableHead>
                <TableHead>{t("scheduledTasks.col.nextRun")}</TableHead>
                <TableHead>{t("scheduledTasks.col.lastRun")}</TableHead>
                <TableHead className="text-right">{t("scheduledTasks.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id} className={!task.enabled ? "opacity-60" : undefined}>
                  <TableCell className="max-w-[260px]">
                    <div className="truncate font-medium">{task.name}</div>
                    {task.description && (
                      <div className="truncate text-xs text-muted-foreground">{task.description}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {task.scheduleHuman}
                    </code>
                  </TableCell>
                  <TableCell>
                    {task.outboundChannel ? (
                      <Badge variant="outline" className="gap-1 text-xs">
                        <Send className="size-3" />
                        {task.outboundChannel}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge task={task} t={t} />
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
                  </TableCell>
                  <TableCell className="text-sm">{formatDate(task.nextRunAt)}</TableCell>
                  <TableCell className="text-sm">{formatDate(task.lastRunAt)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => handleToggle(task)}>
                            {task.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{task.enabled ? t("scheduledTasks.pause") : t("scheduledTasks.resume")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => handleRunNow(task)}>
                            <RotateCcw className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("scheduledTasks.runNow")}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => openEdit(task)}>
                            <Pencil className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("common.edit")}</TooltipContent>
                      </Tooltip>
                      <AlertDialog>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="size-8 text-destructive">
                                <Trash2 className="size-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                          </TooltipTrigger>
                          <TooltipContent>{t("common.delete")}</TooltipContent>
                        </Tooltip>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("scheduledTasks.deleteTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("scheduledTasks.deleteDescription", { name: task.name })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDelete(task.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              {t("common.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </TooltipProvider>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {editingId ? t("scheduledTasks.editTitle") : t("scheduledTasks.createTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("scheduledTasks.dialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto flex-1 pr-1">
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

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
              {editingId ? t("common.save") : t("scheduledTasks.form.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
