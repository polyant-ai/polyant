// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadFailed } from "@/components/ui/load-failed";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { ListHead, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { useListView } from "@/components/use-list-view";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { useI18n } from "@/lib/i18n/context";
import { api, type AdminUser } from "@/lib/api";
import { CreateUserSheet } from "./create-user-sheet";
import { UserSheet } from "./user-sheet";

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
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [openUser, setOpenUser] = useState<AdminUser | null>(null);

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
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [page]);

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
  const roleLabel = (u: AdminUser) => (u.isPlatformAdmin ? t("users.role.platformAdmin") : t("users.role.user"));
  const visible = useListView(users, search, (u) => [u.name, u.email, roleLabel(u)], null);

  return (
    <div className="flex flex-col">
      <div className="flex items-end justify-between gap-4">
        <p className="mt-1 text-muted-foreground">{t("users.subtitle")}</p>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t("users.create")}
        </Button>
      </div>

      {failed ? (
        <LoadFailed onRetry={refresh} />
      ) : loading && users.length === 0 ? (
        <ListLoading />
      ) : users.length === 0 ? (
        <ListEmpty title={t("users.empty.title")} description={t("users.empty.description")} />
      ) : (
        <>
          <ListToolbar value={search} onChange={setSearch} className="mt-6" />
          {visible.length === 0 ? (
            <ListNoResults />
          ) : (
            <ListTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ListHead>{t("common.name")}</ListHead>
                  <ListHead className="w-40">{t("common.role")}</ListHead>
                  <ListHead className="w-40">{t("users.table.password")}</ListHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((u) => (
                  <ListRow key={u.id} onOpen={() => setOpenUser(u)} selected={openUser?.id === u.id}>
                    <ListNameCell
                      name={u.name ?? u.email}
                      onOpen={() => setOpenUser(u)}
                      summary={u.name ? u.email : undefined}
                    />
                    <TableCell>
                      <Badge variant={u.isPlatformAdmin ? "default" : "secondary"}>{roleLabel(u)}</Badge>
                    </TableCell>
                    <TableCell>
                      {!u.hasPassword ? (
                        <span className="text-sm text-muted-foreground">{t("users.password.notSet")}</span>
                      ) : u.mustChangePassword ? (
                        <Badge variant="secondary">{t("users.password.mustChange")}</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t("users.password.set")}</span>
                      )}
                    </TableCell>
                  </ListRow>
                ))}
              </TableBody>
            </ListTable>
          )}
        </>
      )}

      {!loading && total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
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

      <CreateUserSheet open={createOpen} onOpenChange={setCreateOpen} onCreated={refresh} />
      <UserSheet
        key={openUser?.id ?? "closed"}
        user={openUser}
        isSelf={openUser?.id === currentUserId}
        onClose={() => setOpenUser(null)}
        onChanged={refresh}
      />
    </div>
  );
}
