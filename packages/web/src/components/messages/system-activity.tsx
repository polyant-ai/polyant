// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Terminal } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ActivityRow } from "./activity-row";
import { useI18n } from "@/lib/i18n/context";

export function SystemActivity({ content, timestamp }: { content: string; timestamp?: string }) {
  const { t } = useI18n();
  return (
    <div className="border-l border-border pl-3">
      <ActivityRow
        icon={<Terminal className="size-3.5" />}
        iconLabel={t("conversations.detail.systemMessage")}
        timestamp={timestamp}
        detail={<div className="prose-sm max-w-none break-words"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>}
      >
        {content.split("\n").find((line) => line.trim())?.slice(0, 100) || "—"}
      </ActivityRow>
    </div>
  );
}
