// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { ConversationsView } from "@/components/conversations/conversations-view";
import { useI18n } from "@/lib/i18n/context";

/** The workspace-wide list. The table itself is shared with the agent's Attività. */
export default function ConversationsPage() {
  const { t } = useI18n();

  return (
    <div>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t("conversations.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("conversations.subtitle")}</p>
      </div>
      <div className="mt-6">
        <ConversationsView />
      </div>
    </div>
  );
}
