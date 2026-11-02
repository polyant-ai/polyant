// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";

/**
 * The generated description under a conversation's title, held to two lines.
 * The toggle appears only when the text is longer than that, measured on the
 * rendered paragraph, so a short description shows no button.
 */
export function ConversationSummary({ summary }: { summary: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    // Measured only while clamped: expanded, the paragraph never overflows.
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [summary, expanded]);

  return (
    <div className="mt-1 text-sm text-muted-foreground">
      <p ref={ref} className={expanded ? undefined : "line-clamp-2"}>
        {summary}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="text-xs font-medium hover:text-foreground"
        >
          {expanded ? t("common.hide") : t("conversations.detail.summaryMore")}
        </button>
      )}
    </div>
  );
}
