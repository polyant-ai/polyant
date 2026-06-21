// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState, useCallback } from "react";
import { usePagination } from "@/hooks/use-pagination";
import { Brain, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { api, getUserErrorMessage, type Instance, type Memory } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/format";
import { CreateMemoryDialog } from "./create-memory-dialog";

const CATEGORIES = ["", "general", "preference", "fact", "event", "relationship", "decision"] as const;

function importanceBadgeVariant(importance: number): "default" | "secondary" | "destructive" | "outline" {
  if (importance >= 8) return "destructive";
  if (importance >= 5) return "default";
  return "secondary";
}

export default function MemoryPage() {
  const { t } = useI18n();
  const PAGE_SIZE = 20;
  const { page, setPage, search, setSearch, debouncedSearch, totalPages, setTotal, offset } = usePagination({ pageSize: PAGE_SIZE });
  const [memories, setMemories] = useState<Memory[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [instanceFilter, setInstanceFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  // Fetch instances for filter dropdown
  useEffect(() => {
    api.instances.list().then(({ agents }) => setInstances(agents)).catch(() => {});
  }, []);

  // Fetch memories
  const fetchMemories = useCallback(async () => {
    if (!instanceFilter) {
      setMemories([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.memories.list({
        agentId: instanceFilter,
        search: debouncedSearch || undefined,
        category: categoryFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setMemories(result.memories);
      setTotal(result.total);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("common.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [page, instanceFilter, categoryFilter, debouncedSearch, offset, setTotal]);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  const handleDelete = async (id: string) => {
    try {
      await api.memories.delete(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      setTotal((prev) => prev - 1);
      toast.success(t("memory.deleted"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("memory.deleteFailed")));
    }
  };

  // Map agentId to instance name
  const instanceMap = new Map(instances.map((i) => [i.slug, i.name]));

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("memory.title")}
          </h1>
          <p className="mt-1 text-muted-foreground">{t("memory.subtitle")}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("memory.addMemory")}
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Select
          value={instanceFilter || "_all"}
          onValueChange={(v) => { setInstanceFilter(v === "_all" ? "" : v); setPage(1); }}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t("memory.selectInstance")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t("memory.selectInstance")}</SelectItem>
            {instances.map((inst) => (
              <SelectItem key={inst.id} value={inst.slug}>
                {inst.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={categoryFilter || "_all"}
          onValueChange={(v) => { setCategoryFilter(v === "_all" ? "" : v); setPage(1); }}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder={t("memory.allCategories")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t("memory.allCategories")}</SelectItem>
            {CATEGORIES.filter(Boolean).map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder={t("memory.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <div className="mt-6">
        {!instanceFilter ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="rounded-full bg-muted p-4">
              <Brain className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">
              {t("memory.selectInstancePrompt")}
            </h3>
          </div>
        ) : loading ? (
          <p className="text-muted-foreground">{t("common.loading")}</p>
        ) : memories.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <div className="rounded-full bg-muted p-4">
              <Brain className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">
              {debouncedSearch
                ? t("memory.empty.searchTitle")
                : t("memory.empty.title")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {debouncedSearch
                ? t("memory.empty.searchDescription")
                : t("memory.empty.description")}
            </p>
          </div>
        ) : (
          <>
            <div className="w-full overflow-hidden">
            <Table className="table-fixed w-full">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50%]">{t("memory.table.content")}</TableHead>
                  <TableHead>{t("memory.table.category")}</TableHead>
                  <TableHead>{t("memory.table.importance")}</TableHead>
                  <TableHead>{t("memory.table.updated")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {memories.map((mem) => (
                  <TableRow key={mem.id}>
                    <TableCell className="font-medium break-words whitespace-normal">
                      {mem.content}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{mem.category}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={importanceBadgeVariant(mem.importance)}>
                        {mem.importance}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelativeTime(mem.updatedAt, t)}
                    </TableCell>
                    <TableCell>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("memory.deleteTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("memory.deleteDescription")}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDelete(mem.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              {t("common.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-center gap-4">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  {t("memory.previous")}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("memory.next")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <CreateMemoryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        instances={instances}
        defaultInstanceId={instanceFilter}
        onCreated={fetchMemories}
      />
    </div>
  );
}
