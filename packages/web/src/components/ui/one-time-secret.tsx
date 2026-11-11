// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { toast } from "sonner";
import { CopyButton } from "@/components/ui/copy-button";
import { useI18n } from "@/lib/i18n/context";

/**
 * A secret the server will not show again: the value in a monospace box with a
 * copy button beside it. A failed copy says so (the value is still on screen for
 * a manual copy, but the person has to be told the clipboard was not written).
 * `copiedMessage` is the toast shown once the clipboard accepted it.
 */
export function OneTimeSecret({
  value,
  copiedMessage,
  copyLabel,
}: {
  value: string;
  copiedMessage: string;
  copyLabel?: string;
}) {
  const { t } = useI18n();
  const label = copyLabel ?? t("common.copy");
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 font-mono text-sm">
      <span className="flex-1 break-all" data-testid="one-time-secret">
        {value}
      </span>
      <CopyButton value={value} label={label} onCopied={() => toast.success(copiedMessage)} />
    </div>
  );
}
