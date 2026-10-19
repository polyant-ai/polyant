// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  FileText,
  Trash2,
  RefreshCw,
  Loader2,
  Eye,
  Download,
  Upload,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadFailed } from "@/components/ui/load-failed";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, getUserErrorMessage, type Instance, type KnowledgeDocument } from "@/lib/api";
import { providerName } from "@/lib/provider-secrets";
import { useI18n } from "@/lib/i18n/context";
import { useResource } from "@/hooks/use-resource";
import { downloadBlob } from "@/lib/download";
import { usePageSaveAction } from "./page-actions-context";
import { useDraft } from "./use-draft";
import { AddTextDialog } from "@/components/knowledge/add-text-dialog";
import { formatBytes, KnowledgeStatusBadge } from "@/components/knowledge/document-status";

interface Props {
  slug: string;
  /** For the capability switches above the documents — see `KnowledgeCapabilities`. */
  instance: Instance;
  onUpdate: (instance: Instance) => void;
}

/**
 * The switch that turns the knowledge base ON, above the documents it governs.
 *
 * It used to live in the model settings, three tabs away from the thing it
 * enables — so an empty-looking knowledge base gave no hint that it was simply
 * switched off.
 *
 * MEMORY sits beside it now, moved off Configurazione → Generale where it lived
 * next to the agent's name and icon. Both switches answer one question — what
 * this agent knows — and the two halves of that answer were two destinations
 * apart.
 *
 * Both ride the page's Save (`usePageSaveAction`) rather than writing on change.
 * They used to disagree: memory waited for Save because it sat among fields that
 * do, retrieval wrote on the flick because it was "just one boolean". Two
 * switches on one page with two different commit rules is exactly the ambiguity
 * an explicit Save exists to remove.
 */
function KnowledgeToggle({
  instance,
  onUpdate,
}: {
  instance: Instance;
  onUpdate: (i: Instance) => void;
}) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const { draft, set, isDirty } = useDraft({ enabled: instance.knowledgeEnabled ?? false });
  const { enabled } = draft;

  const handleSave = async () => {
    setSaving(true);
    try {
      const { instance: updated } = await api.instances.update(instance.slug, {
        knowledgeEnabled: enabled,
      });
      onUpdate(updated);
      toast.success(t("general.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("general.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  usePageSaveAction({ isDirty, saving, onSave: handleSave });

  return (
    <section className="mb-6 space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        {/* Named for the CAPABILITY, not repeated from the tab: "Knowledge Base"
            here said the same word as the tab above it, and a bare "when this is
            on…" sentence made an important feature read like a footnote. The
            capability has a name — retrieval over the documents — so the row says
            it, with what it costs the agent underneath. */}
        <div className="space-y-1">
          <Label htmlFor="agent-knowledge" className="text-base font-medium">
            {t("knowledge.tab.enableTitle")}
          </Label>
          <p className="text-sm text-muted-foreground">{t("knowledge.tab.enableHelp")}</p>
        </div>
        <Switch
          id="agent-knowledge"
          checked={enabled}
          disabled={saving}
          onCheckedChange={(v) => set("enabled", v)}
        />
      </div>


      {/* Retrieval embeds every document, so without embedder credentials this
          switch produces a green toast and then a knowledge base where every
          upload ends in `status: error` with nothing saying why.
          `instance.embedder` is the ENGINE's answer — `instance.memory` cannot
          stand in, being all-false whenever memory is off, and a client-side copy
          of the rule cannot read the encrypted secrets it depends on. */}
      {enabled && instance.embedder?.needsCredentials && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-900 dark:text-amber-200">
            {/* Names the SELECTED embedder — see the same banner on the memory
                card. Bedrock keeps its own wording: it needs a region, not a key. */}
            {instance.embeddingProvider === "bedrock"
              ? t("settings.tab.knowledgeAwsWarning")
              : t("settings.tab.knowledgeEmbedderWarning", {
                  provider: providerName(instance.embeddingProvider ?? "openai"),
                })}
          </p>
        </div>
      )}
    </section>
  );
}

export function KnowledgeTab({ slug, instance, onUpdate }: Props) {
  const { t } = useI18n();
  const { data, error, loading, reload: load } = useResource(["knowledge", slug], () => api.knowledge.list(slug));
  const documents: KnowledgeDocument[] = data?.documents ?? [];
  const [deleting, setDeleting] = useState<KnowledgeDocument | null>(null);
  const [viewDocId, setViewDocId] = useState<string | null>(null);
  const [viewContent, setViewContent] = useState<string>("");
  const [viewFilename, setViewFilename] = useState<string>("");
  const [viewLoading, setViewLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Poll for processing documents (max 60 attempts = ~3 minutes)
  const pollCountRef = useRef(0);
  const MAX_POLL_ATTEMPTS = 60;

  /*
    Derived from `documents` rather than read off a ref, because it has to be a
    DEPENDENCY. The effect used to read `documentsRef.current` and declare only
    `[load, t]`, both stable: it ran once at mount, when `documents` was still
    empty, so the interval never started. A document left in `processing` never
    refreshed and the timeout toast never fired.
  */
  const hasProcessing = documents.some(
    (d) => d.status === "processing" || d.status === "uploading",
  );

  useEffect(() => {
    if (!hasProcessing) {
      pollCountRef.current = 0;
      return;
    }

    if (pollCountRef.current >= MAX_POLL_ATTEMPTS) {
      return;
    }

    const interval = setInterval(() => {
      pollCountRef.current += 1;
      if (pollCountRef.current >= MAX_POLL_ATTEMPTS) {
        clearInterval(interval);
        toast.error(
          t("knowledge.tab.processingTimeout"),
        );
        return;
      }
      load();
    }, 3000);
    return () => clearInterval(interval);
  }, [hasProcessing, load, t]);

  const handleUpload = async (filename: string, content: string) => {
    try {
      await api.knowledge.upload(slug, { filename, content: content.trim() });
      toast.success(t("knowledge.tab.uploaded"));
      load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.uploadFailed")));
      throw err;
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const bundle = await api.knowledge.export(slug);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      downloadBlob(blob, `${slug}-knowledge.json`);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.exportFailed")));
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so the same file can be picked again
    if (!file) return;

    setImporting(true);
    try {
      const text = await file.text();
      let bundle: { version?: number; documents: { filename: string; content: string }[] };
      try {
        bundle = JSON.parse(text);
      } catch {
        throw new Error(t("knowledge.tab.importInvalidJson"));
      }
      const res = await api.knowledge.import(slug, bundle);
      const renamed = res.documents.filter((d) => d.renamedFrom).length;
      toast.success(t("knowledge.tab.imported", { count: res.imported, renamed }));
      load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.importFailed")));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (docId: string) => {
    try {
      await api.knowledge.delete(slug, docId);
      toast.success(t("knowledge.tab.deleted"));
      setDeleting(null);
      load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.deleteFailed")));
    }
  };

  const handleView = async (docId: string, docFilename: string) => {
    setViewDocId(docId);
    setViewFilename(docFilename);
    setViewLoading(true);
    setViewContent("");
    try {
      const { document } = await api.knowledge.get(slug, docId);
      setViewContent(document.rawContent);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.loadFailed")));
      setViewDocId(null);
    } finally {
      setViewLoading(false);
    }
  };

  if (error && data === undefined) return <LoadFailed message={t("knowledge.tab.loadFailed")} onRetry={load} />;

  if (loading && data === undefined) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  // Disabled knowledge means the documents are NOT reachable by the model. The
  // list stayed fully interactive when the switch was off, which reads as "these
  // are in use" — so everything below is dimmed and inert, and says why.
  const knowledgeEnabled = instance.knowledgeEnabled ?? false;

  return (
    <div className="max-w-3xl">
      <KnowledgeToggle instance={instance} onUpdate={onUpdate} />
      <div
        className={
          knowledgeEnabled ? undefined : "pointer-events-none opacity-50"
        }
        aria-disabled={!knowledgeEnabled}
      >
      <div className="mb-6 flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{t("knowledge.tab.description")}</p>
          {/* Added, not substituted: what the list IS does not change when the
              agent stops consulting it, so replacing the description hid a
              standing fact to state a temporary one. */}
          {!knowledgeEnabled && (
            <p className="text-sm font-medium">{t("knowledge.tab.disabledNotice")}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={load}>
            <RefreshCw className="size-4" />
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Upload className="mr-1.5 size-4" />}
            {t("knowledge.tab.import")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exporting || documents.length === 0}
          >
            {exporting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Download className="mr-1.5 size-4" />}
            {/* "Esporta documenti", not "Esporta": the page header carries an
                Esporta too, and that one exports the AGENT. One word, two
                different things, forty pixels apart. */}
            {t("knowledge.exportDocuments")}
          </Button>
          <AddTextDialog onAdd={handleUpload} />
        </div>
      </div>

      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <FileText className="mx-auto mb-3 size-10 text-muted-foreground/50" />
          <p className="text-sm font-medium">{t("knowledge.tab.empty")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("knowledge.tab.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center justify-between rounded-lg border p-4"
            >
              <div className="flex items-center gap-4 min-w-0 flex-1">
                <FileText className="size-5 shrink-0 text-muted-foreground" />
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">
                      {doc.filename}
                    </span>
                    <KnowledgeStatusBadge status={doc.status} t={t} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(doc.sizeBytes)}
                    {doc.status === "ready" && ` · ${doc.chunkCount} chunks`}
                    {doc.status === "error" && doc.errorMessage && (
                      <span className="text-destructive">
                        {" "}
                        · {doc.errorMessage}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleView(doc.id, doc.filename)}
                  disabled={doc.status !== "ready"}
                >
                  <Eye className="size-4" />
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(doc)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("knowledge.tab.deleteTitle")}
        description={t("knowledge.tab.deleteDescription", { name: deleting?.filename ?? "" })}
        confirmLabel={t("common.delete")}
        onConfirm={() => deleting ? handleDelete(deleting.id) : undefined}
      />

      {/* View document content dialog */}
      <Dialog open={viewDocId !== null} onOpenChange={(open) => !open && setViewDocId(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl flex flex-col">
          <DialogHeader>
            <DialogTitle>{viewFilename}</DialogTitle>
            <DialogDescription>
              {t("knowledge.tab.viewDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 min-h-0">
            {viewLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <pre className="whitespace-pre-wrap text-sm font-mono bg-muted/50 rounded-md p-4">
                {viewContent}
              </pre>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setViewDocId(null)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
