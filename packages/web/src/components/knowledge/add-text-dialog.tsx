// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n/context";

/**
 * Add a document by typing or pasting its text — the same gesture on the
 * agent's knowledge and on the shared libraries. The owner decides how the text
 * is stored (`onAdd`); the dialog closes and forgets it once that succeeds.
 */
export function AddTextDialog({
  onAdd,
  disabled,
}: {
  onAdd: (filename: string, content: string) => Promise<void>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (!filename.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await onAdd(filename.trim(), content);
      setFilename("");
      setContent("");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Plus className="mr-1.5 size-4" />
          {t("knowledge.tab.pasteText")}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader>
          <DialogTitle>{t("knowledge.tab.uploadTitle")}</DialogTitle>
          <DialogDescription>{t("knowledge.tab.uploadDescription")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <Label htmlFor="add-text-filename">{t("knowledge.tab.filename")}</Label>
            <Input
              id="add-text-filename"
              placeholder={t("knowledge.tab.filenamePlaceholder")}
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-text-content">{t("knowledge.tab.content")}</Label>
            <Textarea
              id="add-text-content"
              placeholder={t("knowledge.tab.contentPlaceholder")}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              className="max-h-[40vh] resize-y font-mono text-sm"
            />
          </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void add()} disabled={saving || !filename.trim() || !content.trim()}>
            {saving ? t("common.saving") : t("knowledge.tab.upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
