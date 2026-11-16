// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { FileText, Image as ImageIcon, Mic, Video } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

const ATTACHMENT_KINDS = {
  image: { icon: ImageIcon, label: "conversations.detail.attachedImage" },
  video: { icon: Video, label: "conversations.detail.attachedVideo" },
  audio: { icon: Mic, label: "conversations.detail.attachedAudio" },
  file: { icon: FileText, label: "conversations.detail.attachedFile" },
} as const;

/**
 * What came with a message whose files are not on screen: the kinds and how
 * many, so a photo sent with no caption does not read as an empty message. The
 * transcript uses it when the agent did not store the files, the live turn
 * before the message is stored at all.
 */
export function AttachmentKinds({ kinds, isUser }: { kinds: unknown; isUser: boolean }) {
  const { t } = useI18n();
  if (!Array.isArray(kinds)) return null;
  const counts = new Map<keyof typeof ATTACHMENT_KINDS, number>();
  for (const kind of kinds) {
    const known = typeof kind === "string" && kind in ATTACHMENT_KINDS ? (kind as keyof typeof ATTACHMENT_KINDS) : "file";
    counts.set(known, (counts.get(known) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${isUser ? "text-primary-foreground/80" : "text-muted-foreground"}`}
      title={t("conversations.detail.attachmentNotStored")}
    >
      {[...counts].map(([kind, count]) => {
        const { icon: Icon, label } = ATTACHMENT_KINDS[kind];
        return (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {t(label, { count })}
          </span>
        );
      })}
    </div>
  );
}
