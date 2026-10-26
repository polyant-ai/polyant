// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DrawerDeleteButton, ListDrawer } from "@/components/list-drawer";
import { MEMBER_ROLES, type MemberRole, type OrganizationMember } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

export const ROLE_LABEL_KEY: Record<MemberRole, TranslationKey> = {
  owner: "role.owner",
  admin: "role.admin",
  member: "role.member",
  viewer: "role.viewer",
};

/**
 * One member, opened from the row: the role to change and the removal, which
 * asks first. The last Owner's role and removal are locked (the engine refuses
 * both), and removing yourself is not offered: it is leaving, not member
 * management, and the engine refuses it too.
 */
export function MemberSheet({
  member,
  locked,
  busy,
  isSelf,
  onRoleChange,
  onRemove,
  onClose,
}: {
  member: OrganizationMember | null;
  locked: boolean;
  busy: boolean;
  isSelf: boolean;
  onRoleChange: (member: OrganizationMember, role: MemberRole) => void;
  /** Resolves true once the member was removed. */
  onRemove: (member: OrganizationMember) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <ListDrawer
        open={member !== null}
        onOpenChange={(open) => !open && onClose()}
        title={member ? member.name ?? member.email : ""}
        description={member ? (member.name ? member.email : member.roleKey ? t(ROLE_LABEL_KEY[member.roleKey]) : "") : ""}
        destructive={
          member &&
          (isSelf ? (
            <span className="text-sm text-muted-foreground">{t("members.remove.self")}</span>
          ) : (
            <DrawerDeleteButton
              label={t("members.remove.button")}
              disabled={locked || busy}
              onClick={() => setConfirming(true)}
            />
          ))
        }
      >
        {member && (
          <div className="space-y-2">
            <Label htmlFor="member-role">{t("common.role")}</Label>
            <Select
              value={member.roleKey ?? undefined}
              disabled={locked || busy}
              onValueChange={(value) => onRoleChange(member, value as MemberRole)}
            >
              <SelectTrigger id="member-role" className="w-[220px]">
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
          </div>
        )}
      </ListDrawer>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("members.remove.title")}
        description={member ? t("members.remove.description", { email: member.email }) : undefined}
        confirmLabel={t("members.remove.confirm")}
        pending={busy}
        onConfirm={async () => {
          if (!member) return;
          const removed = await onRemove(member);
          setConfirming(false);
          if (removed) onClose();
        }}
      />
    </>
  );
}
