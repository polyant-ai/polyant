// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ListDrawer } from "@/components/list-drawer";
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

/**
 * The form, mounted only while the drawer is open, so every opening starts from empty fields and the current default agent
 * without a reset function or a re-sync effect.
 */
function CreateMemoryForm({ onOpenChange, instances, defaultInstanceId, onCreated }: Omit<Props, "open">) {
  const { t } = useI18n();
  const [instanceId, setInstanceId] = useState(defaultInstanceId ?? "");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<string>("general");
  const [importance, setImportance] = useState<string>("5");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!instanceId || !content.trim()) return;
    setCreating(true);
    try {
      await api.memories.create({
        instanceId,
        content: content.trim(),
        category,
        importance: Number(importance),
      });
      toast.success(t("memory.create.success"));
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("memory.create.error")));
    } finally {
      setCreating(false);
    }
  };

  return (
    <ListDrawer
      open
      onOpenChange={onOpenChange}
      title={t("memory.create.title")}
      description={t("memory.create.description")}
      primary={
        <Button onClick={handleCreate} disabled={creating || !instanceId || !content.trim()}>
          {creating ? t("common.saving") : t("common.add")}
        </Button>
      }
    >
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t("memory.create.instance")}</Label>
        <Select
          value={instanceId}
          onValueChange={setInstanceId}
          disabled={!!defaultInstanceId}
        >
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

    </ListDrawer>
  );
}

export function CreateMemorySheet({ open, onOpenChange, ...form }: Props) {
  // Mounted only while open, so every opening starts from empty fields.
  if (!open) return null;
  return <CreateMemoryForm key={form.defaultInstanceId ?? ""} onOpenChange={onOpenChange} {...form} />;
}
