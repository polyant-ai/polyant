// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { Lock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useI18n } from "@/lib/i18n/context";

/**
 * Rendered in place of a surface the engine refused with 403.
 *
 * The panel cannot hide what a caller may not read: it holds no permission
 * read-model (see `isForbidden` in `lib/api.ts`), so a nav entry is offered to
 * everyone and the page learns its own inaccessibility from the refusal. Without
 * this state the refusal became a generic "failed to load" toast over an empty
 * table — indistinguishable from "there is nothing here yet", which is the one
 * reading that sends someone looking for a bug that does not exist.
 *
 * Sibling of `TenantUnavailable`, and the same principle: name the cause, and
 * offer an action only where one exists. Here none does — a role is granted by
 * someone else — so the copy says who to ask instead of pretending otherwise.
 */
export function PermissionRequired({ description }: { description?: string }) {
  const { t } = useI18n();

  return (
    <EmptyState
      icon={Lock}
      title={t("permission.required.title")}
      description={description ?? t("permission.required.description")}
    />
  );
}
