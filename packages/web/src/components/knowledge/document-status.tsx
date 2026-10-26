// SPDX-License-Identifier: AGPL-3.0-or-later

import { StatusBadge } from "@/components/status-badge";
import type { KnowledgeDocument } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n/types";

/** The state of a knowledge document as a status badge: ready, still being read, or failed. */
export function KnowledgeStatusBadge({
  status,
  t,
}: {
  status: KnowledgeDocument["status"];
  t: (key: TranslationKey) => string;
}) {
  switch (status) {
    case "ready":
      return <StatusBadge tone="positive">{t("knowledge.tab.statusReady")}</StatusBadge>;
    case "processing":
      return <StatusBadge tone="neutral">{t("knowledge.tab.statusProcessing")}</StatusBadge>;
    case "uploading":
      return <StatusBadge tone="neutral">{t("knowledge.tab.statusUploading")}</StatusBadge>;
    case "error":
      return <StatusBadge tone="negative">{t("knowledge.tab.statusError")}</StatusBadge>;
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
