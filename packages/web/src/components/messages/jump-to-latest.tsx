// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";

/**
 * Back to the newest message, offered while the reader has scrolled up in a
 * conversation that keeps growing. Sticky at the bottom of the scroll
 * container, so it needs no positioned wrapper around it.
 */
export function JumpToLatest({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <div className="pointer-events-none sticky bottom-3 flex justify-center">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="pointer-events-auto animate-conversation-enter rounded-full shadow-md"
        onClick={onClick}
      >
        <ArrowDown className="size-4" />
        {t("conversations.detail.jumpToLatest")}
      </Button>
    </div>
  );
}
