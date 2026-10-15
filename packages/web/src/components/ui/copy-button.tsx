// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useI18n } from "@/lib/i18n/context";

/** An icon button that copies `value` and shows a check mark for a moment once the clipboard accepted it. */
export function CopyButton({
  value,
  label,
  variant = "ghost",
  className,
}: {
  value: string;
  /** Accessible name; defaults to "Copy". */
  label?: string;
  variant?: "ghost" | "outline";
  className?: string;
}) {
  const { t } = useI18n();
  const { copy, copied } = useCopyToClipboard();
  const name = label ?? t("common.copy");
  return (
    <Button type="button" variant={variant} size="icon" className={className} aria-label={name} title={name} onClick={() => void copy(value)}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}
