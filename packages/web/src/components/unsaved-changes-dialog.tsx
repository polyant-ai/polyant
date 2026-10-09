// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/lib/i18n/context";

/**
 * The question a sheet asks when it is closed with values not yet saved. Cancel
 * keeps the sheet open as it is; `onDiscard` drops the typed values and closes.
 */
export function UnsavedChangesDialog({
  open,
  onOpenChange,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("unsavedChanges.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("unsavedChanges.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("unsavedChanges.keepEditing")}</AlertDialogCancel>
          <AlertDialogAction onClick={onDiscard}>{t("unsavedChanges.discard")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
