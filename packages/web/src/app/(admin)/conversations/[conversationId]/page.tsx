// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useParams } from "next/navigation";
import { LegacyTenantRedirect } from "@/components/layout/legacy-tenant-redirect";

export default function LegacyConversationDetailPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return (
    <LegacyTenantRedirect sub={`/conversations/${encodeURIComponent(conversationId)}`} />
  );
}
