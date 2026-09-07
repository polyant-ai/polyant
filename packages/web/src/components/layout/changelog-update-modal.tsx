// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChangelogCheck } from "@/hooks/use-changelog-check";
import { useI18n } from "@/lib/i18n/context";
import { ChangelogEntryCard } from "./changelog-entry-card";

/**
 * Mounted once in the admin layout. Gated inside useChangelogCheck to
 * Platform Admin only — a self-hosted operator, not every member, is the
 * intended audience for "a new version of Polyant is available".
 */
export function ChangelogUpdateModal() {
  const { t } = useI18n();
  const { version, newVersionAvailable, unseenChangelogs, markAsSeen } = useChangelogCheck();

  return (
    <Dialog open={newVersionAvailable} onOpenChange={(open) => !open && markAsSeen()}>
      <DialogContent className="max-h-[80vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("changelog.modalTitle")}</DialogTitle>
          <DialogDescription>{t("changelog.modalSubtitle", { version })}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[55vh] pr-4">
          <div className="space-y-3">
            {unseenChangelogs.length > 0 ? (
              unseenChangelogs.map((entry) => <ChangelogEntryCard key={entry.version} entry={entry} />)
            ) : (
              <p className="text-sm text-muted-foreground">{t("changelog.empty")}</p>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" asChild>
            <Link href="/about" onClick={markAsSeen}>
              {t("changelog.viewFull")}
            </Link>
          </Button>
          <Button onClick={markAsSeen}>{t("changelog.dismiss")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
