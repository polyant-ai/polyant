// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  api,
  getUserErrorMessage,
  MEMBER_ROLES,
  type MemberRole,
  type OrganizationMember,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

const ROLE_LABEL_KEY: Record<MemberRole, TranslationKey> = {
  owner: "role.owner",
  admin: "role.admin",
  member: "role.member",
  viewer: "role.viewer",
};

export default function MembersPage() {
  const { t } = useI18n();
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    try {
      const { members } = await api.members.list();
      setMembers(members);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("members.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  // The org must always keep at least one Owner. When a single Owner remains,
  // the UI locks that Owner's role select + remove action (the engine enforces
  // the same Owner-last guard server-side; this just avoids a doomed request).
  const ownerCount = members.filter((m) => m.roleKey === "owner").length;
  const isSoloOwner = ownerCount === 1;

  const handleRoleChange = async (member: OrganizationMember, roleKey: MemberRole) => {
    if (roleKey === member.roleKey) return;
    setBusyUserId(member.userId);
    try {
      await api.members.assign(member.userId, roleKey);
      setMembers((prev) =>
        prev.map((m) => (m.userId === member.userId ? { ...m, roleKey } : m)),
      );
      toast.success(t("members.roleUpdated"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("members.roleUpdateFailed")));
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRemove = async (member: OrganizationMember) => {
    setBusyUserId(member.userId);
    try {
      await api.members.remove(member.userId);
      setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
      toast.success(t("members.removed"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("members.removeFailed")));
    } finally {
      setBusyUserId(null);
    }
  };

  if (loading) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t("members.title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t("members.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("members.subtitle")}</p>
      </div>

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
        <div className="mt-16 flex flex-col items-center text-center">
          <p className="text-muted-foreground">{t("members.empty.title")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("members.empty.description")}
          </p>
        </div>
      ) : (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>{t("members.table.member")}</TableHead>
              <TableHead>{t("members.table.email")}</TableHead>
              <TableHead className="w-[200px]">{t("members.table.role")}</TableHead>
              <TableHead className="w-[120px]">{t("members.table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const locked = isSoloOwner && member.roleKey === "owner";
              const busy = busyUserId === member.userId;
              return (
                <TableRow key={member.userId}>
                  <TableCell className="font-medium">
                    {member.name ?? member.email}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{member.email}</TableCell>
                  <TableCell>
                    <Select
                      value={member.roleKey ?? undefined}
                      disabled={locked || busy}
                      onValueChange={(value) =>
                        handleRoleChange(member, value as MemberRole)
                      }
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder={t("members.rolePlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {MEMBER_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {t(ROLE_LABEL_KEY[role])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" disabled={locked || busy}>
                          {t("members.remove.button")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("members.remove.title")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("members.remove.description", { email: member.email })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleRemove(member)}>
                            {t("members.remove.confirm")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
