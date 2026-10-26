// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  RefreshCw,
  Loader2,
  Download,
  Upload,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadFailed } from "@/components/ui/load-failed";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ListEmpty, ListLoading } from "@/components/list-states";
import { SwitchList } from "@/components/switch-list";
import { DrawerDeleteButton, ListDrawer } from "@/components/list-drawer";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, getUserErrorMessage, type Instance, type KnowledgeDocument } from "@/lib/api";
import { providerName } from "@/lib/provider-secrets";
import { useI18n } from "@/lib/i18n/context";
import { useResource } from "@/hooks/use-resource";
import { downloadBlob } from "@/lib/download";
import { SectionActions } from "./section-actions";
import { usePageSaveAction } from "./page-actions-context";
import { useDraft } from "./use-draft";
import { AddTextSheet } from "@/components/knowledge/add-text-sheet";
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
  // Document switches ride the page's Save like the two switches above them: the
  // changes made but not yet saved, by document id.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [savingDocs, setSavingDocs] = useState(false);
  const isOn = (doc: KnowledgeDocument) => pending[doc.id] ?? doc.enabled;
  const setDocEnabled = (doc: KnowledgeDocument, enabled: boolean) =>
    setPending((prev) => {
      const next = { ...prev };
      if (enabled === doc.enabled) delete next[doc.id];
      else next[doc.id] = enabled;
      return next;
    });
  const saveDocSwitches = async () => {
    setSavingDocs(true);
    try {
      await Promise.all(Object.entries(pending).map(([id, enabled]) => api.knowledge.setEnabled(slug, id, enabled)));
      setPending({});
      load();
      toast.success(t("general.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("general.saveFailed")));
    } finally {
      setSavingDocs(false);
    }
  };
  usePageSaveAction({ isDirty: Object.keys(pending).length > 0, saving: savingDocs, onSave: saveDocSwitches });
  const [viewDocId, setViewDocId] = useState<string | null>(null);
  const [viewContent, setViewContent] = useState<string>("");
  const [viewLoading, setViewLoading] = useState(false);
  const [viewFailed, setViewFailed] = useState(false);
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
      setViewDocId(null);
      load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.deleteFailed")));
    }
  };

  /** Opens the document's drawer; a ready document's text is read for it, one still being read or failed has none to show. */
  const handleView = async (doc: KnowledgeDocument) => {
    setViewDocId(doc.id);
    setViewContent("");
    setViewFailed(false);
    if (doc.status !== "ready") {
      setViewLoading(false);
      return;
    }
    setViewLoading(true);
    try {
      const { document } = await api.knowledge.get(slug, doc.id);
      setViewContent(document.rawContent);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.loadFailed")));
      setViewFailed(true);
    } finally {
      setViewLoading(false);
    }
  };

  if (error && data === undefined) return <LoadFailed message={t("knowledge.tab.loadFailed")} onRetry={load} />;

  if (loading && data === undefined) return <ListLoading className="" />;

  // Disabled knowledge means the documents are NOT reachable by the model. The
  // list stayed fully interactive when the switch was off, which reads as "these
  // are in use" — so everything below is dimmed and inert, and says why.
  const knowledgeEnabled = instance.knowledgeEnabled ?? false;

  const statusText = (doc: KnowledgeDocument) =>
    t(
      doc.status === "ready"
        ? "knowledge.tab.statusReady"
        : doc.status === "error"
          ? "knowledge.tab.statusError"
          : doc.status === "uploading"
            ? "knowledge.tab.statusUploading"
            : "knowledge.tab.statusProcessing",
    );
  /** The line under the filename: size, chunks once read, and why a failed one failed. */
  const summaryOf = (doc: KnowledgeDocument) =>
    [
      formatBytes(doc.sizeBytes),
      doc.status === "ready" ? t("knowledge.tab.chunks", { count: doc.chunkCount }) : null,
      doc.status === "error" ? doc.errorMessage : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const viewedDoc = viewDocId ? documents.find((d) => d.id === viewDocId) ?? null : null;

  return (
    <div>
      <SectionActions>
        <Button variant="ghost" size="sm" onClick={load} disabled={!knowledgeEnabled} aria-label={t("knowledge.tab.refresh")}>
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
          disabled={importing || !knowledgeEnabled}
        >
          {importing ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Upload className="mr-1.5 size-4" />}
          {t("knowledge.tab.import")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={exporting || documents.length === 0 || !knowledgeEnabled}
        >
          {exporting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Download className="mr-1.5 size-4" />}
          {/* "Esporta documenti", not "Esporta": the page header carries an
              Esporta too, and that one exports the AGENT. One word, two
              different things, forty pixels apart. */}
          {t("knowledge.exportDocuments")}
        </Button>
        <AddTextSheet onAdd={handleUpload} disabled={!knowledgeEnabled} />
      </SectionActions>

      <KnowledgeToggle instance={instance} onUpdate={onUpdate} />
      <div
        className={
          knowledgeEnabled ? undefined : "pointer-events-none opacity-50"
        }
        aria-disabled={!knowledgeEnabled}
      >
      {!knowledgeEnabled && (
        <p className="text-sm font-medium">{t("knowledge.tab.disabledNotice")}</p>
      )}

      {documents.length === 0 ? (
        <ListEmpty className="mt-8" title={t("knowledge.tab.empty")} description={t("knowledge.tab.emptyHint")} />
      ) : (
        <SwitchList
          rows={documents}
          rowKey={(doc) => doc.id}
          name={(doc) => doc.filename}
          nameHeader={t("common.name")}
          badges={(doc) => <KnowledgeStatusBadge status={doc.status} t={t} />}
          summary={summaryOf}
          searchText={(doc) => [statusText(doc)]}
          isOn={isOn}
          onToggle={async (doc, v) => setDocEnabled(doc, v)}
          switchLabel={(doc) => t("knowledge.tab.docEnabled", { name: doc.filename })}
          onOpen={handleView}
          selectedKey={viewDocId}
        />
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

      {/* The document: its content, and the actions on it. */}
      <ListDrawer
        open={viewedDoc !== null}
        onOpenChange={(open) => !open && setViewDocId(null)}
        title={viewedDoc?.filename ?? ""}
        description={t("knowledge.tab.viewDescription")}
        header={viewedDoc && <div className="flex flex-wrap gap-2 pt-1"><KnowledgeStatusBadge status={viewedDoc.status} t={t} /></div>}
        destructive={viewedDoc && <DrawerDeleteButton onClick={() => setDeleting(viewedDoc)} />}
      >
        {viewLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : viewFailed ? (
          <LoadFailed message={t("knowledge.tab.loadFailed")} />
        ) : viewedDoc?.status === "error" ? (
          <p className="text-sm text-destructive">{viewedDoc.errorMessage || t("knowledge.tab.statusError")}</p>
        ) : viewedDoc?.status === "ready" ? (
          <pre className="whitespace-pre-wrap rounded-md bg-muted/50 p-4 font-mono text-sm">{viewContent}</pre>
        ) : null}
      </ListDrawer>
    </div>
  );
}
