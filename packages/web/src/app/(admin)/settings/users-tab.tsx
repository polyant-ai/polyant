// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { Plus, KeyRound, Trash2, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/lib/i18n/context";
import { api, getUserErrorMessage, type AdminUser } from "@/lib/api";
import { CreateUserDialog } from "./create-user-dialog";
import { EditUserDialog } from "./edit-user-dialog";
import { ResetPasswordDialog } from "./reset-password-dialog";

const PAGE_SIZE = 25;

export function UsersTab() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<AdminUser[]>([]);
  // The engine bounds the response, so the page has to be navigable: without
  // these the list silently stopped at the first page and account 51 was
  // unreachable.
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.users.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      // Clamp back when the page we are on no longer exists. Deleting the only
      // row on the last page left `offset` past the new total, so the table came
      // back empty AND the prev/next controls unmounted (they are hidden once
      // `total <= PAGE_SIZE`) — a dead end escapable only by reloading.
      if (res.users.length === 0 && page > 0) {
        setPage((p) => Math.max(0, Math.min(p - 1, Math.ceil(res.total / PAGE_SIZE) - 1)));
        return;
      }
      setUsers(res.users);
      setTotal(res.total);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("users.create.failed")));
    } finally {
      setLoading(false);
    }
  }, [t, page]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // NOT re-sorted here. The order is the server's — platform admins first, then
  // email — because sorting a single PAGE client-side can only reorder the 25 rows
  // it was given, which is how paginating a browser-sorted list made page 1
  // whatever the planner happened to return. Re-sorting on top of that was also
  // actively wrong at a page boundary: `localeCompare` and the database collation
  // do not agree, so the last row of one page could sort after the first row of
  // the next.
  const sorted = users;

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.users.delete(deleteTarget.id);
      toast.success(t("users.delete.deleted"));
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("users.delete.failed")));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t("users.subtitle")}</p>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 size-4" />
          {t("users.create")}
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("users.table.email")}</TableHead>
              <TableHead>{t("users.table.name")}</TableHead>
              <TableHead>{t("users.table.role")}</TableHead>
              <TableHead>{t("users.table.password")}</TableHead>
              <TableHead className="text-right">
                {t("users.table.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {t("users.empty.description")}
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.email}</TableCell>
                  <TableCell>{u.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={u.isPlatformAdmin ? "default" : "secondary"}>
                      {u.isPlatformAdmin
                        ? t("users.role.platformAdmin")
                        : t("users.role.user")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {!u.hasPassword ? (
                      <span className="text-muted-foreground text-sm">
                        {t("users.password.notSet")}
                      </span>
                    ) : u.mustChangePassword ? (
                      <Badge variant="outline">
                        {t("users.password.mustChange")}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        {t("users.password.set")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("users.action.edit")}
                        onClick={() => setEditTarget(u)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("users.action.resetPassword")}
                        onClick={() => setResetTarget(u)}
                      >
                        <KeyRound className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t("users.action.delete")}
                        disabled={u.id === currentUserId}
                        onClick={() => setDeleteTarget(u)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {!loading && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t("users.pagination.range", {
              from: String(page * PAGE_SIZE + 1),
              to: String(Math.min((page + 1) * PAGE_SIZE, total)),
              total: String(total),
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {t("common.previous")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              {t("common.next")}
            </Button>
          </div>
        </div>
      )}

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={refresh}
      />
      <EditUserDialog
        user={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={refresh}
      />
      <ResetPasswordDialog
        user={resetTarget}
        onClose={() => setResetTarget(null)}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("users.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("users.delete.description")}
              {deleteTarget && (
                <span className="mt-2 block font-medium">
                  {deleteTarget.email}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}>
              {t("users.delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
