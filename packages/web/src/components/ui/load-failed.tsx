// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/context";

/**
 * Stated in place of data that could not be read. An empty table after a failed
 * load reads as "nothing here yet", the one conclusion that sends someone looking
 * for a bug that does not exist, so a failure says it is one and offers a retry.
 */
export function LoadFailed({
  message,
  hint,
  onRetry,
  retryLabel,
  className,
}: {
  message?: string;
  hint?: string;
  onRetry?: () => void;
  /** The retry button's text; defaults to "Try again". */
  retryLabel?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div role="alert" className={`flex flex-col items-center gap-2 py-10 text-center ${className ?? ""}`}>
      <AlertCircle className="size-6 text-destructive" aria-hidden />
      <p className="text-sm font-medium">{message ?? t("common.loadFailed")}</p>
      {hint && <p className="max-w-md text-sm text-muted-foreground">{hint}</p>}
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {retryLabel ?? t("common.retry")}
        </Button>
      )}
    </div>
  );
}
