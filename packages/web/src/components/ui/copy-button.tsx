// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useI18n } from "@/lib/i18n/context";

/**
 * A button that copies `value` and shows a check mark for a moment once the clipboard accepted it.
 * An icon button by default; with `copiedLabel` it is a small button that also writes "Copy" and,
 * afterwards, `copiedLabel` next to the icon.
 */
export function CopyButton({
  value,
  label,
  copiedLabel,
  variant = "ghost",
  className,
  disabled,
  errorMessage,
  onCopied,
}: {
  value: string;
  /** Accessible name and, with `copiedLabel`, the visible text; defaults to "Copy". */
  label?: string;
  /** Switches to the labelled form and is the text shown after a successful copy. */
  copiedLabel?: string;
  variant?: "ghost" | "outline";
  className?: string;
  disabled?: boolean;
  /** Replaces the default failure toast text. */
  errorMessage?: string;
  /** Runs once the clipboard accepted the text. */
  onCopied?: () => void;
}) {
  const { t } = useI18n();
  const { copy, copied } = useCopyToClipboard(2000, errorMessage);
  const name = label ?? t("common.copy");
  const labelled = copiedLabel !== undefined;
  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant={variant}
      size={labelled ? "sm" : "icon"}
      className={labelled ? `gap-1.5 ${className ?? ""}`.trim() : className}
      disabled={disabled}
      aria-label={labelled ? undefined : name}
      title={labelled ? undefined : name}
      onClick={async () => {
        if (await copy(value)) onCopied?.();
      }}
    >
      <Icon className={labelled ? "size-3.5" : "size-4"} />
      {labelled && (copied ? copiedLabel : name)}
    </Button>
  );
}
