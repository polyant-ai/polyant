// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { Plus, Bot, List, LayoutGrid, Upload, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { CreateInstanceDialog } from "./create-instance-dialog";
import { formatRelativeTime } from "@/lib/format";
import { isSafeImageSrc } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

type ViewMode = "list" | "grid";
const STORAGE_KEY = "instances-view-mode";
const SHOW_INACTIVE_STORAGE_KEY = "instances-show-inactive";

function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>("list");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ViewMode;
    if (saved && (saved === "list" || saved === "grid")) setMode(saved);
  }, []);

  const setAndPersist = useCallback((next: ViewMode) => {
    setMode(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return [mode, setAndPersist];
}

/** Persist the "show inactive instances" toggle. Default: hidden. */
function useShowInactive(): [boolean, (next: boolean) => void] {
  const [show, setShow] = useState<boolean>(false);

  useEffect(() => {
    const saved = localStorage.getItem(SHOW_INACTIVE_STORAGE_KEY);
    if (saved === "true") setShow(true);
  }, []);

  const setAndPersist = useCallback((next: boolean) => {
    setShow(next);
    localStorage.setItem(SHOW_INACTIVE_STORAGE_KEY, String(next));
  }, []);

  return [show, setAndPersist];
}

function InstanceGrid({ instances }: { instances: Instance[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {instances.map((inst) => (
        <Link
          key={inst.id}
          href={`/instances/${inst.slug}`}
          className="group flex flex-col items-center gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
        >
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border bg-muted">
            {inst.icon && isSafeImageSrc(inst.icon) ? (
              <Image
                src={inst.icon}
                alt=""
                width={64}
                height={64}
                className="h-full w-full object-cover"
                unoptimized
              />
            ) : (
              <Bot className="h-8 w-8 text-muted-foreground" />
            )}
          </div>
          <div className="w-full text-center">
            <p className="truncate text-sm font-medium group-hover:underline">
              {inst.name}
            </p>
            <Badge
              variant={inst.status === "active" ? "default" : "secondary"}
              className="mt-1 text-[10px]"
            >
              {inst.status}
            </Badge>
          </div>
        </Link>
      ))}
    </div>
  );
}

function InstanceList({ instances, t }: {
  instances: Instance[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("instances.table.name")}</TableHead>
          <TableHead>{t("instances.table.slug")}</TableHead>
          <TableHead>{t("instances.table.status")}</TableHead>
          <TableHead className="hidden md:table-cell">
            {t("instances.table.description")}
          </TableHead>
          <TableHead className="text-right">
            {t("instances.table.updated")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {instances.map((inst) => (
          <TableRow key={inst.id} className="cursor-pointer">
            <TableCell className="font-medium">
              <Link
                href={`/instances/${inst.slug}`}
                className="flex items-center gap-2 hover:underline"
              >
                {inst.icon && isSafeImageSrc(inst.icon) ? (
                  <Image
                    src={inst.icon}
                    alt=""
                    width={24}
                    height={24}
                    className="h-6 w-6 shrink-0 rounded object-cover"
                    unoptimized
                  />
                ) : (
                  <Bot className="h-6 w-6 shrink-0 text-muted-foreground" />
                )}
                {inst.name}
              </Link>
            </TableCell>
            <TableCell>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {inst.slug}
              </code>
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  inst.status === "active" ? "default" : "secondary"
                }
              >
                {inst.status}
              </Badge>
            </TableCell>
            <TableCell className="hidden max-w-xs truncate md:table-cell text-muted-foreground">
              {inst.description ?? "\u2014"}
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              {formatRelativeTime(inst.updatedAt, t)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function InstancesPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewMode, setViewMode] = useViewMode();
  const [showInactive, setShowInactive] = useShowInactive();
  const [importing, setImporting] = useState(false);
  const [importWarnings, setImportWarnings] = useState<{ type: string; message: string }[] | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const result = await api.exportImport.importNew(bundle);

      if (result.warnings.length > 0) {
        setImportWarnings(result.warnings);
      }

      toast.success(t("exportImport.import.success"));
      await fetchInstances();

      // Navigate to the new instance
      router.push(`/instances/${result.slug}`);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("exportImport.import.failed")));
    } finally {
      setImporting(false);
      if (importFileRef.current) importFileRef.current.value = "";
    }
  };

  const fetchInstances = async () => {
    try {
      const { instances } = await api.instances.list();
      setInstances(instances);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("common.loadFailed")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInstances();
    // Load once on mount. `fetchInstances` is a stable closure; adding it to
    // deps without useCallback would re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hide inactive instances by default. The toggle is purely client-side —
  // the API still returns every instance regardless of status.
  const visibleInstances = showInactive
    ? instances
    : instances.filter((i) => i.status === "active");
  const hiddenCount = instances.length - visibleInstances.length;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("instances.title")}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t("instances.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border">
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="icon"
              className="h-9 w-9 rounded-r-none"
              onClick={() => setViewMode("list")}
              title={t("instances.viewList")}
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "grid" ? "default" : "ghost"}
              size="icon"
              className="h-9 w-9 rounded-l-none"
              onClick={() => setViewMode("grid")}
              title={t("instances.viewGrid")}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center rounded-md border">
            <Button
              variant={!showInactive ? "default" : "ghost"}
              size="sm"
              className="h-9 rounded-r-none"
              onClick={() => setShowInactive(false)}
            >
              {t("instances.filter.activeOnly")}
            </Button>
            <Button
              variant={showInactive ? "default" : "ghost"}
              size="sm"
              className="h-9 rounded-l-none"
              onClick={() => setShowInactive(true)}
            >
              {t("instances.filter.all")}
              {!showInactive && hiddenCount > 0 ? (
                <span className="ml-1 opacity-70">({hiddenCount})</span>
              ) : null}
            </Button>
          </div>
          <Button
            variant="outline"
            onClick={() => importFileRef.current?.click()}
            disabled={importing}
            className="gap-2"
          >
            <Upload className="h-4 w-4" />
            {importing ? t("exportImport.import.uploading") : t("exportImport.importNew.button")}
          </Button>
          <input
            ref={importFileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("instances.newInstance")}
          </Button>
        </div>
      </div>

      <div className="mt-8">
        {loading ? (
          viewMode === "list" ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full rounded-lg" />
              ))}
            </div>
          )
        ) : visibleInstances.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="rounded-full bg-muted p-4">
              <Bot className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mt-4 text-lg font-medium">
              {t("instances.empty.title")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("instances.empty.description")}
            </p>
            <Button className="mt-4" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("instances.empty.cta")}
            </Button>
          </div>
        ) : viewMode === "list" ? (
          <InstanceList instances={visibleInstances} t={t} />
        ) : (
          <InstanceGrid instances={visibleInstances} />
        )}
      </div>

      <CreateInstanceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => {
          setDialogOpen(false);
          fetchInstances();
        }}
      />

      {/* Import Warnings Dialog */}
      <Dialog open={importWarnings !== null} onOpenChange={() => setImportWarnings(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("exportImport.import.warningsTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("exportImport.import.warningsDescription")}
          </p>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
            {importWarnings?.map((w, i) => (
              <li key={i} className="flex items-start gap-2 rounded p-2 bg-muted">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                {w.message}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
