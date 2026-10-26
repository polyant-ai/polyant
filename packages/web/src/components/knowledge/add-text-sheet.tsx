// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ListDrawer } from "@/components/list-drawer";
import { useI18n } from "@/lib/i18n/context";

/**
 * Add a document by typing or pasting its text. The owner decides how the text
 * is stored (`onAdd`); the drawer closes and forgets it once that succeeds.
 */
export function AddTextSheet({
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
    <>
      <Button size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 size-4" />
        {t("knowledge.tab.pasteText")}
      </Button>
      <ListDrawer
        open={open}
        onOpenChange={setOpen}
        title={t("knowledge.tab.uploadTitle")}
        description={t("knowledge.tab.uploadDescription")}
        primary={
          <Button onClick={() => void add()} disabled={saving || !filename.trim() || !content.trim()}>
            {saving ? t("common.saving") : t("common.add")}
          </Button>
        }
      >
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
      </ListDrawer>
    </>
  );
}
