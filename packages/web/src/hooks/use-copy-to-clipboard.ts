// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/context";

/**
 * Copy text to the clipboard and tell the user how it went.
 *
 * `copy` awaits the write, so "copied" is only reported once the browser accepted
 * it: `navigator.clipboard` is missing on insecure origins and rejects when
 * permission is denied, and claiming success there sends a person off to paste
 * something that is not on their clipboard. A failure raises an error toast.
 * `copied` is true for `resetMs` after a success, for a button that flips to a
 * check mark, and its timer is cleared on unmount. Resolves to whether it worked.
 */
export function useCopyToClipboard(resetMs = 2000) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        toast.error(t("common.copyFailed"));
        return false;
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetMs);
      return true;
    },
    [resetMs, t],
  );

  return { copy, copied };
}
