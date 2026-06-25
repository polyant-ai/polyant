// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

const CATEGORIES = ["general", "preference", "fact", "event", "relationship", "decision"] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instances: Instance[];
  defaultInstanceId?: string;
  onCreated: () => void;
}

export function CreateMemoryDialog({ open, onOpenChange, instances, defaultInstanceId, onCreated }: Props) {
  const { t } = useI18n();
  const [agentId, setInstanceId] = useState(defaultInstanceId ?? "");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<string>("general");
  const [importance, setImportance] = useState<string>("5");
  const [creating, setCreating] = useState(false);

  const resetForm = () => {
    setContent("");
    setCategory("general");
    setImportance("5");
    if (!defaultInstanceId) setInstanceId("");
  };

  const handleCreate = async () => {
    if (!agentId || !content.trim()) return;
    setCreating(true);
    try {
      await api.memories.create({
        agentId,
        content: content.trim(),
        category,
        importance: Number(importance),
      });
      toast.success(t("memory.create.success"));
      resetForm();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("memory.create.error")));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("memory.create.title")}</DialogTitle>
          <DialogDescription>{t("memory.create.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t("memory.create.instance")}</Label>
            <Select value={agentId} onValueChange={setInstanceId}>
              <SelectTrigger>
                <SelectValue placeholder={t("memory.create.instance")} />
              </SelectTrigger>
              <SelectContent>
                {instances.map((inst) => (
                  <SelectItem key={inst.id} value={inst.slug}>
                    {inst.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("memory.table.content")}</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("memory.create.contentPlaceholder")}
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("memory.create.category")}</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t("memory.create.importance")}</Label>
              <Select value={importance} onValueChange={setImportance}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={creating || !agentId || !content.trim()}>
            {creating ? t("common.saving") : t("memory.create.button")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
