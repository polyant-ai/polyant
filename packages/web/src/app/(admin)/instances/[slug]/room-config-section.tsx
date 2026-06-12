// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/lib/i18n/context";

const OUTBOUND_CHANNELS = ["slack", "whatsapp", "telegram"];

export interface RoomFormState {
  enabled: boolean;
  prompt: string;
  outboundChannel: string;
  outboundTarget: string;
  evalIntervalMinutes: number;
}

interface Props {
  form: RoomFormState;
  onChange: (form: RoomFormState) => void;
  onDelete?: () => void;
  isNew: boolean;
}

export function RoomConfigSection({ form, onChange, onDelete, isNew }: Props) {
  const { t } = useI18n();
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("room.config.title")}</h2>
        <div className="flex items-center gap-3">
          <Switch checked={form.enabled} onCheckedChange={(v) => onChange({ ...form, enabled: v })} />
          {!isNew && onDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" className="text-destructive">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("room.deleted")}</AlertDialogTitle>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={onDelete}>{t("common.delete")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <Label>{t("room.config.prompt")}</Label>
        <p className="text-xs text-muted-foreground">{t("room.config.promptHelp")}</p>
        <Textarea
          className="min-h-[120px]"
          placeholder={t("room.config.promptPlaceholder")}
          value={form.prompt}
          onChange={(e) => onChange({ ...form, prompt: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>{t("room.config.outboundChannel")}</Label>
          <Select value={form.outboundChannel || "none"} onValueChange={(v) => onChange({ ...form, outboundChannel: v === "none" ? "" : v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">—</SelectItem>
              {OUTBOUND_CHANNELS.map((ch) => (
                <SelectItem key={ch} value={ch}>{ch}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("room.config.outboundTarget")}</Label>
          <p className="text-xs text-muted-foreground">{t("room.config.outboundTargetHelp")}</p>
          <Input value={form.outboundTarget} onChange={(e) => onChange({ ...form, outboundTarget: e.target.value })} />
        </div>
      </div>

      <div className="space-y-1">
        <Label>{t("room.config.evalInterval")}</Label>
        <Input
          type="number"
          min={1}
          value={form.evalIntervalMinutes}
          onChange={(e) => onChange({ ...form, evalIntervalMinutes: Number(e.target.value) })}
        />
      </div>
    </section>
  );
}
