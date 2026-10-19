// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { ConversationsView } from "@/components/conversations/conversations-view";
import { PageHeader } from "@/components/layout/page-header";
import { useI18n } from "@/lib/i18n/context";

/** The workspace-wide list. The table itself is shared with the agent's Attività. */
export default function ConversationsPage() {
  const { t } = useI18n();

  return (
    <div>
      <PageHeader title={t("conversations.title")} subtitle={t("conversations.subtitle")} />
      <div className="mt-6" data-tour="conv-table">
        <ConversationsView />
      </div>
    </div>
  );
}
