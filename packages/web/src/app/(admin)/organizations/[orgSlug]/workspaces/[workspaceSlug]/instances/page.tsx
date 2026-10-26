// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { Plus, Bot, List, LayoutGrid, Upload, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ListBadgeCell, ListHead, ListMetaCell, ListNameCell, ListRow, ListTable } from "@/components/list-table";
import { ListToolbar } from "@/components/list-search";
import { useListView } from "@/components/use-list-view";
import { ListEmpty, ListLoading, ListNoResults } from "@/components/list-states";
import { LoadFailed } from "@/components/ui/load-failed";
import { PageHeader } from "@/components/layout/page-header";
import { useResource } from "@/hooks/use-resource";
import { usePersistedState } from "@/hooks/use-persisted-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, getUserErrorMessage, type Instance } from "@/lib/api";
import { CreateInstanceSheet } from "./create-instance-sheet";
import { useFormat } from "@/lib/use-format";
import { isSafeImageSrc } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";
import { instanceStatusLabel } from "@/lib/instance-status";
import type { TranslationKey } from "@/lib/i18n/types";
import { useTenantPaths, type TenantPaths } from "@/lib/tenant/use-tenant-paths";

type ViewMode = "list" | "grid";
const STORAGE_KEY = "instances-view-mode";
const parseViewMode = (raw: string): ViewMode | undefined => (raw === "list" || raw === "grid" ? raw : undefined);

const SHOW_INACTIVE_STORAGE_KEY = "instances-show-inactive";

const parseBool = (raw: string): boolean | undefined => (raw === "true" ? true : raw === "false" ? false : undefined);

/** The same agents as cards; each card is a real link to the agent's page. */
function InstanceGrid({ instances, paths }: { instances: Instance[]; paths: TenantPaths }) {
  const { t } = useI18n();
  return (
    <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {instances.map((inst) => (
        <Link
          key={inst.id}
          href={paths.workspace(`/instances/${encodeURIComponent(inst.slug)}`)}
          className="group flex flex-col items-center gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
        >
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border bg-muted">
            {inst.icon && isSafeImageSrc(inst.icon) ? (
              <Image src={inst.icon} alt="" width={64} height={64} className="h-full w-full object-cover" unoptimized />
            ) : (
              <Bot className="h-8 w-8 text-muted-foreground" />
            )}
          </div>
          <div className="w-full text-center">
            <p className="truncate text-sm font-medium group-hover:underline">{inst.name}</p>
            {inst.description && (
              <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground" title={inst.description}>
                {inst.description}
              </p>
            )}
            <div className="mt-1">
              <StatusBadge tone={inst.status === "active" ? "positive" : "neutral"}>
                {instanceStatusLabel(inst.status, t)}
              </StatusBadge>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

/**
 * The agents of the workspace. An agent is a destination with a page of its own,
 * so a row goes there instead of opening a drawer.
 */
function InstanceList({ instances, t, paths }: {
  instances: Instance[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  paths: TenantPaths;
}) {
  const fmt = useFormat();
  return (
    <ListTable>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <ListHead>{t("instances.table.name")}</ListHead>
          <ListHead className="w-48">{t("instances.table.slug")}</ListHead>
          <ListHead className="w-32">{t("instances.table.status")}</ListHead>
          <ListHead align="end" className="w-36">{t("instances.table.updated")}</ListHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {instances.map((inst) => {
          const href = paths.workspace(`/instances/${encodeURIComponent(inst.slug)}`);
          return (
            <ListRow key={inst.id} href={href}>
              <ListNameCell
                name={inst.name}
                href={href}
                summary={inst.description || undefined}
                icon={
                  inst.icon && isSafeImageSrc(inst.icon) ? (
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
                  )
                }
              />
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{inst.slug}</code>
              </TableCell>
              <ListBadgeCell tone={inst.status === "active" ? "positive" : "neutral"}>
                {instanceStatusLabel(inst.status, t)}
              </ListBadgeCell>
              <ListMetaCell align="end">{fmt.relative(inst.updatedAt)}</ListMetaCell>
            </ListRow>
          );
        })}
      </TableBody>
    </ListTable>
  );
}

export default function InstancesPage() {
  const { t } = useI18n();
  const router = useRouter();
  const paths = useTenantPaths();
  const { data, error, loading, reload } = useResource(["instances", paths.workspace("")], () => api.instances.list());
  const instances: Instance[] = data?.instances ?? [];
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = usePersistedState<ViewMode>(STORAGE_KEY, "list", parseViewMode);
  // Hide inactive instances by default.
  const [showInactive, setShowInactive] = usePersistedState(SHOW_INACTIVE_STORAGE_KEY, false, parseBool);
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

      // The list page reloads itself when it is opened again.
      router.push(paths.workspace(`/instances/${encodeURIComponent(result.slug)}`));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("exportImport.import.failed")));
    } finally {
      setImporting(false);
      if (importFileRef.current) importFileRef.current.value = "";
    }
  };

  // The active/all toggle and the search are purely client-side: the API
  // returns every agent regardless of status.
  const visibleInstances = useListView(
    instances.filter((i) => showInactive || i.status === "active"),
    search,
    (i) => [i.name, i.slug, i.description, instanceStatusLabel(i.status, t)],
    (i) => i.name,
  );
  const hiddenCount = instances.filter((i) => i.status !== "active").length;

  return (
    <div>
      <PageHeader
        title={t("instances.title")}
        subtitle={t("instances.subtitle")}
        actions={
          data !== undefined && (
            <>
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
              <Button onClick={() => setDialogOpen(true)} data-tour="new-agent">
                <Plus className="h-4 w-4" />
                {t("instances.newInstance")}
              </Button>
            </>
          )
        }
      />

      {error && data === undefined ? (
        <LoadFailed onRetry={reload} />
      ) : loading && data === undefined ? (
        <ListLoading />
      ) : instances.length === 0 ? (
        <ListEmpty
          title={t("instances.empty.title")}
          description={t("instances.empty.description")}
          action={
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              {t("instances.empty.cta")}
            </Button>
          }
        />
      ) : (
        <div>
          <ListToolbar value={search} onChange={setSearch} className="mt-6">
            <div className="flex items-center rounded-md border">
              <Button
                variant={viewMode === "list" ? "default" : "ghost"}
                size="icon"
                className="h-9 w-9 rounded-r-none"
                onClick={() => setViewMode("list")}
                title={t("instances.viewList")}
                aria-label={t("instances.viewList")}
              >
                <List className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "grid" ? "default" : "ghost"}
                size="icon"
                className="h-9 w-9 rounded-l-none"
                onClick={() => setViewMode("grid")}
                title={t("instances.viewGrid")}
                aria-label={t("instances.viewGrid")}
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
                {!showInactive && hiddenCount > 0 ? <span className="ml-1 opacity-70">({hiddenCount})</span> : null}
              </Button>
            </div>
          </ListToolbar>
          {visibleInstances.length === 0 ? (
            <ListNoResults />
          ) : viewMode === "list" ? (
            <InstanceList instances={visibleInstances} t={t} paths={paths} />
          ) : (
            <InstanceGrid instances={visibleInstances} paths={paths} />
          )}
        </div>
      )}

      <CreateInstanceSheet
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => {
          setDialogOpen(false);
          reload();
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
