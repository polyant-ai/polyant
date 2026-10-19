// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { KnowledgeDocument } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n/types";

/** The state of a knowledge document as a badge: ready, still being read, or failed. */
export function KnowledgeStatusBadge({
  status,
  t,
}: {
  status: KnowledgeDocument["status"];
  t: (key: TranslationKey) => string;
}) {
  switch (status) {
    case "ready":
      return (
        <Badge variant="default" className="gap-1">
          <CheckCircle2 className="size-3" />
          {t("knowledge.tab.statusReady")}
        </Badge>
      );
    case "processing":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 animate-spin" />
          {t("knowledge.tab.statusProcessing")}
        </Badge>
      );
    case "uploading":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 animate-spin" />
          {t("knowledge.tab.statusUploading")}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="size-3" />
          {t("knowledge.tab.statusError")}
        </Badge>
      );
  }
}

/** A document's size for a reader: B, KB, MB or GB, one decimal at most. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
