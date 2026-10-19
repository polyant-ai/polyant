// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Say so when a reload fails while the page still shows the earlier answer.
 *
 * `useResource` keeps its data through a failed reload, so a page that only
 * renders its failure state while `data` is missing would keep showing rows the
 * engine may no longer hold, with no message. Pass the resource's `error`, whether
 * it holds `data`, and the text to show.
 */
export function useReloadFailureToast(error: unknown, hasData: boolean, message: string): void {
  const messageRef = useRef(message);
  useEffect(() => {
    messageRef.current = message;
  });
  useEffect(() => {
    if (error !== undefined && hasData) toast.error(messageRef.current);
  }, [error, hasData]);
}
