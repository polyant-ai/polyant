// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import {
  api,
  getUserErrorMessage,
  isForbidden,
  type MemberRole,
  type OrganizationMember,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { PageHeader } from "@/components/layout/page-header";
import { LoadFailed } from "@/components/ui/load-failed";
import { useResource } from "@/hooks/use-resource";
import { PermissionRequired } from "@/components/layout/permission-required";
import { ListHead, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { useListView } from "@/components/use-list-view";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { MemberSheet, ROLE_LABEL_KEY } from "./member-sheet";

export default function MembersPage() {
  const { t } = useI18n();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data, error, loading, reload, mutate } = useResource(["members", orgSlug], () => api.members.list(orgSlug));
  const members = data?.members ?? [];
  // `org.member:manage` is admin+. The entry is now offered to every role (it
  // used to be platform-admin-only, which hid it from the org Owner it exists
  // for), so a viewer reaching it is expected and gets an explanation.
  const forbidden = isForbidden(error);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openUserId, setOpenUserId] = useState<string | null>(null);

  // The org must always keep at least one Owner. When a single Owner remains,
  // the UI locks that Owner's role select + remove action (the engine enforces
  // the same Owner-last guard server-side; this just avoids a doomed request).
  const ownerCount = members.filter((m) => m.roleKey === "owner").length;
  const isSoloOwner = ownerCount === 1;

  const handleRoleChange = async (member: OrganizationMember, roleKey: MemberRole) => {
    if (roleKey === member.roleKey) return;
    setBusyUserId(member.userId);
    try {
      await api.members.assign(member.userId, roleKey, orgSlug);
      reload();
      toast.success(t("members.roleUpdated"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("members.roleUpdateFailed")));
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRemove = async (member: OrganizationMember): Promise<boolean> => {
    setBusyUserId(member.userId);
    try {
      await api.members.remove(member.userId, orgSlug);
      mutate((current) => ({ ...current, members: current.members.filter((m) => m.userId !== member.userId) }));
      reload();
      toast.success(t("members.removed"));
      return true;
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("members.removeFailed")));
      return false;
    } finally {
      setBusyUserId(null);
    }
  };

  const roleLabel = (m: OrganizationMember) => (m.roleKey ? t(ROLE_LABEL_KEY[m.roleKey]) : "");
  const visible = useListView(members, search, (m) => [m.name, m.email, roleLabel(m)], (m) => m.name ?? m.email);
  const openMember = openUserId === null ? null : members.find((m) => m.userId === openUserId) ?? null;

  const header = <PageHeader title={t("members.title")} subtitle={t("members.subtitle")} />;

  if (loading && data === undefined) {
    return (
      <div>
        {header}
        <ListLoading />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div>
        {header}
        <PermissionRequired description={t("permission.required.members")} />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {header}
        <LoadFailed message={t("members.loadFailed")} onRetry={reload} />
      </div>
    );
  }

  return (
    <div>
      {header}

      {isSoloOwner && (
        <div className="mt-6 flex items-start gap-3 rounded-md border border-border bg-secondary p-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">{t("members.soloOwner.title")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("members.soloOwner.description")}
            </p>
          </div>
        </div>
      )}

      {members.length === 0 ? (
        <ListEmpty title={t("members.empty.title")} description={t("members.empty.description")} />
      ) : (
        <>
          <ListToolbar value={search} onChange={setSearch} className="mt-6" />
          {visible.length === 0 ? (
            <ListNoResults />
          ) : (
            <div data-tour="members-table">
              <ListTable>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <ListHead>{t("common.name")}</ListHead>
                    <ListHead className="w-40">{t("common.role")}</ListHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((member) => (
                    <ListRow
                      key={member.userId}
                      onOpen={() => setOpenUserId(member.userId)}
                      selected={openUserId === member.userId}
                    >
                      <ListNameCell
                        name={member.name ?? member.email}
                        onOpen={() => setOpenUserId(member.userId)}
                        summary={member.name ? member.email : undefined}
                      />
                      <TableCell>
                        {member.roleKey ? <Badge variant="secondary">{t(ROLE_LABEL_KEY[member.roleKey])}</Badge> : "—"}
                      </TableCell>
                    </ListRow>
                  ))}
                </TableBody>
              </ListTable>
            </div>
          )}
        </>
      )}

      <MemberSheet
        member={openMember}
        locked={openMember !== null && isSoloOwner && openMember.roleKey === "owner"}
        busy={openMember !== null && busyUserId === openMember.userId}
        // Removing yourself is leaving, not member management, and the
        // engine refuses it: the session would keep an organization it no
        // longer belongs to, and the panel would empty out at the next
        // reload with nothing said. The drawer states why instead of
        // offering a button whose only outcome is a 403.
        isSelf={openMember !== null && openMember.userId === currentUserId}
        onRoleChange={handleRoleChange}
        onRemove={handleRemove}
        onClose={() => setOpenUserId(null)}
      />
    </div>
  );
}
