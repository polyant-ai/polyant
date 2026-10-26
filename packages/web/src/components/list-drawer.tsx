// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n/context";

/**
 * The right-hand drawer a list row opens: what the row is on top (a title and
 * a line of description), its details in a scrolling body, its actions in the
 * footer. Viewing and editing a listed item always happens here, never in a
 * dialog or on a page of its own.
 *
 * The footer has one shape, so drawers cannot drift apart: the destructive
 * action (delete, revoke, remove, each asking first) on the left; on the right
 * the extra secondary actions, then Cancel and the primary button when the
 * drawer edits or creates, or a single Close when it only shows.
 */
export function ListDrawer({
  open,
  onOpenChange,
  title,
  description,
  header,
  destructive,
  actions,
  primary,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** The one line under the title. */
  description: ReactNode;
  /** Extra content under the description, such as badges. */
  header?: ReactNode;
  /** The destructive action, on the left. */
  destructive?: ReactNode;
  /** Secondary actions on the right, before Cancel or Close (export, upgrade). */
  actions?: ReactNode;
  /** The primary button of a drawer that edits or creates; without it the drawer only shows and closes. */
  primary?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0">
        <SheetHeader className="gap-1 border-b p-5 pr-12">
          <SheetTitle className="break-words text-base font-medium">{title}</SheetTitle>
          <SheetDescription className="line-clamp-2">{description}</SheetDescription>
          {header}
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">{children}</div>
        <SheetFooter className="flex-row items-center justify-between border-t p-4">
          <div>{destructive}</div>
          <div className="flex items-center gap-2">
            {actions}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {primary ? t("common.cancel") : t("common.close")}
            </Button>
            {primary}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** The delete button of a drawer's footer; the page opens its own confirmation from `onClick`. */
export function DrawerDeleteButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Button type="button" variant="ghost" className="text-destructive" disabled={disabled} onClick={onClick}>
      <Trash2 className="size-4" aria-hidden />
      {label ?? t("common.delete")}
    </Button>
  );
}
