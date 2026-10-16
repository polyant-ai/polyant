// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useRef, useState, useCallback } from "react";
import { Bot, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n/context";

const ICON_SIZE = 128;
const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"];
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

interface IconUploadProps {
  icon: string | null;
  onUpload: (dataUri: string) => Promise<void>;
  onRemove: () => Promise<void>;
}

/**
 * Resize and center-crop an image file to 128x128 PNG data URI.
 *
 * Decodes with createImageBitmap so no blob: URL is loaded: the page CSP
 * allows only 'self', https: and data: images.
 */
async function resizeToIcon(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");

    // Center-crop: use the largest square from the center
    const size = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - size) / 2;
    const sy = (bitmap.height - size) / 2;
    ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, ICON_SIZE, ICON_SIZE);

    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

export function IconUpload({ icon, onUpload, onRemove }: IconUploadProps) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!ALLOWED_MIME.includes(file.type)) {
        toast.error(t("general.iconInvalidType"));
        if (fileRef.current) fileRef.current.value = "";
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(t("general.iconTooLarge"));
        if (fileRef.current) fileRef.current.value = "";
        return;
      }

      setUploading(true);
      try {
        const dataUri = await resizeToIcon(file);
        await onUpload(dataUri);
      } catch {
        toast.error(t("general.iconUploadFailed"));
      } finally {
        setUploading(false);
        // Reset input so same file can be re-selected
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [onUpload, t],
  );

  const handleRemove = useCallback(async () => {
    setUploading(true);
    try {
      await onRemove();
    } finally {
      setUploading(false);
    }
  }, [onRemove]);

  return (
    <div className="space-y-2">
      <Label>{t("general.icon")}</Label>
      <div className="flex items-center gap-4">
        {/* Preview */}
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {icon ? (
            <img
              src={icon}
              alt="Icon"
              className="h-full w-full object-cover"
            />
          ) : (
            <Bot className="h-8 w-8 text-muted-foreground" />
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {uploading ? "..." : t("general.iconUpload")}
          </Button>
          {icon && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={handleRemove}
              className="text-muted-foreground"
            >
              <X className="h-4 w-4" />
              {t("general.iconRemove")}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            {t("general.iconHelp")}
          </p>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
