// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState, useCallback } from "react";
import { usePagination } from "@/hooks/use-pagination";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  TableBody,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ListBadgeCell, ListHead, ListMetaCell, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { DrawerDeleteButton, ListDrawer } from "@/components/list-drawer";
import { LoadFailed } from "@/components/ui/load-failed";
import { truncate } from "@/lib/format";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Pager } from "@/components/ui/pager";
import { OptionalSelect } from "@/components/optional-select";
import { api, getUserErrorMessage, type Instance, type Memory } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { useFormat } from "@/lib/use-format";
import { useWorkspaceSlug } from "@/lib/tenant/use-workspace-slug";
import { CreateMemorySheet } from "@/components/memory/create-memory-sheet";

const CATEGORIES = ["", "general", "preference", "fact", "event", "relationship", "decision"] as const;

/**
 * The saved-memories list — ONE implementation, two places.
 *
 * The workspace page renders it with the agent picker; the agent's Attività
 * section passes `lockedInstanceId`, which fixes the agent and drops both the
 * picker and the "pick an agent first" empty state that stands in for it.
 *
 * Writing a fact by hand is the same act wherever the list is shown, so the
 * create drawer lives here; the button that opens it sits in the page's header
 * (or the agent section's actions) and the page owns `createOpen`.
 *
 * Search is the engine's (it matches the memory's text with the whole store,
 * not the page of rows on screen), so the box is not filtered here. Rows are
 * ordered by the engine, newest first. A row opens the memory, where deleting it
 * (after confirming) lives.
 */
export function MemoryView({
  lockedInstanceId,
  createOpen,
  onCreateOpenChange,
}: {
  lockedInstanceId?: string;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const workspaceSlug = useWorkspaceSlug();
  const PAGE_SIZE = 20;
  const { page, setPage, search, setSearch, debouncedSearch, totalPages, setTotal, offset } = usePagination({ pageSize: PAGE_SIZE });
  const [memories, setMemories] = useState<Memory[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [instanceFilter, setInstanceFilter] = useState(lockedInstanceId ?? "");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Fetch instances for filter dropdown — re-fetch when workspace changes.
  // Also reset the stale instance filter so the user doesn't see an empty list.
  useEffect(() => {
    if (lockedInstanceId) return;
    setInstanceFilter("");
    setPage(1);
    api.instances
      .list()
      .then(({ instances }) => {
        setInstances(instances);
        // Memory is read per agent, so the page used to open blank until one was
        // picked. Preselect the first, once per workspace: a person who then
        // clears the picker on purpose is left alone.
        if (instances[0]) setInstanceFilter(instances[0].slug);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  // Fetch memories
  const fetchMemories = useCallback(async () => {
    if (!instanceFilter) {
      setMemories([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    try {
      const result = await api.memories.list({
        instanceId: instanceFilter,
        search: debouncedSearch || undefined,
        category: categoryFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setMemories(result.memories);
      setTotal(result.total);
    } catch (err) {
      setFailed(true);
      toast.error(getUserErrorMessage(err, t("common.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [instanceFilter, categoryFilter, debouncedSearch, offset, setTotal, t]);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  const handleDelete = async (id: string) => {
    try {
      await api.memories.delete(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      setTotal((prev) => prev - 1);
      setOpenId((current) => (current === id ? null : current));
      toast.success(t("memory.deleted"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("memory.deleteFailed")));
    } finally {
      setPendingDelete(null);
    }
  };

  // Under a page header the empty state sits lower than inside an agent's section.
  const emptyClass = lockedInstanceId ? "mt-8" : "mt-16";
  const open = memories.find((m) => m.id === openId) ?? null;

  return (
    <div>
      <ListToolbar value={search} onChange={setSearch} label={t("memory.searchPlaceholder")}>
        {!lockedInstanceId && (
          <OptionalSelect
            value={instanceFilter}
            onChange={(instance) => { setInstanceFilter(instance); setPage(1); }}
            allLabel={t("memory.selectInstance")}
            options={instances.map((inst) => ({ value: inst.slug, label: inst.name }))}
          />
        )}

        <OptionalSelect
          value={categoryFilter}
          onChange={(category) => { setCategoryFilter(category); setPage(1); }}
          allLabel={t("memory.allCategories")}
          options={CATEGORIES.filter(Boolean).map((c) => ({ value: c, label: c }))}
          className="w-[180px]"
        />
      </ListToolbar>

      <div>
        {!instanceFilter ? (
          <ListEmpty className={emptyClass} title={t("memory.selectInstancePrompt")} />
        ) : failed ? (
          <LoadFailed onRetry={fetchMemories} />
        ) : loading ? (
          <ListLoading className="mt-4" />
        ) : memories.length === 0 ? (
          debouncedSearch ? (
            <ListNoResults>{t("memory.empty.searchTitle")}</ListNoResults>
          ) : (
            <ListEmpty className={emptyClass} title={t("memory.empty.title")} description={t("memory.empty.description")} />
          )
        ) : (
          <>
            <ListTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <ListHead>{t("memory.table.content")}</ListHead>
                  <ListHead className="w-36">{t("memory.table.category")}</ListHead>
                  <ListHead className="w-32">{t("memory.table.importance")}</ListHead>
                  <ListHead align="end" className="w-36">{t("memory.table.updated")}</ListHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {memories.map((mem) => (
                  <ListRow key={mem.id} onOpen={() => setOpenId(mem.id)} selected={openId === mem.id}>
                    <ListNameCell name={truncate(mem.content, 120)} onOpen={() => setOpenId(mem.id)} />
                    <ListBadgeCell>{mem.category}</ListBadgeCell>
                    <ListBadgeCell>{mem.importance}</ListBadgeCell>
                    <ListMetaCell align="end">{fmt.relative(mem.updatedAt)}</ListMetaCell>
                  </ListRow>
                ))}
              </TableBody>
            </ListTable>

            <Pager page={page} totalPages={totalPages} onPage={setPage} />
          </>
        )}
      </div>

      <ListDrawer
        open={open !== null}
        onOpenChange={(next) => !next && setOpenId(null)}
        title={open ? truncate(open.content, 60) : ""}
        description={open ? fmt.relative(open.updatedAt) : ""}
        header={
          open && (
            <div className="flex gap-2 pt-1">
              <Badge variant="secondary">{open.category}</Badge>
              <Badge variant="secondary">{open.importance}</Badge>
            </div>
          )
        }
        destructive={open && <DrawerDeleteButton onClick={() => setPendingDelete(open.id)} />}
      >
        {open && <p className="whitespace-pre-wrap text-sm">{open.content}</p>}
      </ListDrawer>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
        title={t("memory.deleteTitle")}
        description={t("memory.deleteDescription")}
        confirmLabel={t("common.delete")}
        onConfirm={async () => {
          if (pendingDelete !== null) await handleDelete(pendingDelete);
        }}
      />

      <CreateMemorySheet
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        instances={
          // With the agent fixed the picker is locked to it, but a Select still
          // needs the matching item to render its own value — and the instance
          // list is never fetched in that mode.
          lockedInstanceId && instances.length === 0
            ? [{ id: lockedInstanceId, slug: lockedInstanceId, name: lockedInstanceId } as Instance]
            : instances
        }
        defaultInstanceId={instanceFilter}
        onCreated={fetchMemories}
      />
    </div>
  );
}
