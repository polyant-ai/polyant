// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  FileText,
  Plus,
  Trash2,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Eye,
  Download,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api, getUserErrorMessage, type KnowledgeDocument } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/types";

interface Props {
  slug: string;
}

function StatusBadge({ status, t }: { status: KnowledgeDocument["status"]; t: (key: TranslationKey) => string }) {
  switch (status) {
    case "ready":
      return (
        <Badge variant="default" className="gap-1">
          <CheckCircle2 className="size-3" />
          {t("knowledge.tab.statusReady")}
        </Badge>
      );
    case "processing":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 animate-spin" />
          {t("knowledge.tab.statusProcessing")}
        </Badge>
      );
    case "uploading":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 animate-spin" />
          {t("knowledge.tab.statusUploading")}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="size-3" />
          {t("knowledge.tab.statusError")}
        </Badge>
      );
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function KnowledgeTab({ slug }: Props) {
  const { t } = useI18n();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [viewDocId, setViewDocId] = useState<string | null>(null);
  const [viewContent, setViewContent] = useState<string>("");
  const [viewFilename, setViewFilename] = useState<string>("");
  const [viewLoading, setViewLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { documents: docs } = await api.knowledge.list(slug);
      setDocuments(docs);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll for processing documents (max 60 attempts = ~3 minutes)
  const pollCountRef = useRef(0);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const MAX_POLL_ATTEMPTS = 60;

  useEffect(() => {
    const hasProcessing = documentsRef.current.some(
      (d) => d.status === "processing" || d.status === "uploading",
    );
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
          t("knowledge.tab.processingTimeout") ||
            "Document processing timed out. The document may have failed to process.",
        );
        return;
      }
      load();
    }, 3000);
    return () => clearInterval(interval);
  }, [load, t]);

  const handleUpload = async () => {
    if (!filename.trim() || !content.trim()) return;

    setUploading(true);
    try {
      await api.knowledge.upload(slug, {
        filename: filename.trim(),
        content: content.trim(),
      });
      toast.success(t("knowledge.tab.uploaded"));
      setUploadOpen(false);
      setFilename("");
      setContent("");
      load();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("knowledge.tab.uploadFailed")));
    } finally {
      setUploading(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const bundle = await api.knowledge.export(slug);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}-knowledge.json`;
      a.click();
      URL.revokeObjectURL(url);
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
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
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

  if (loading) {
    return (
      <div className="max-w-3xl">
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t("knowledge.tab.description")}
        </p>
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
            {t("knowledge.tab.export")}
          </Button>
          <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1.5 size-4" />
                {t("knowledge.tab.upload")}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] flex flex-col">
              <DialogHeader>
                <DialogTitle>{t("knowledge.tab.uploadTitle")}</DialogTitle>
                <DialogDescription>
                  {t("knowledge.tab.uploadDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 overflow-y-auto flex-1 min-h-0">
                <div className="space-y-2">
                  <Label>{t("knowledge.tab.filename")}</Label>
                  <Input
                    placeholder={t("knowledge.tab.filenamePlaceholder")}
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("knowledge.tab.content")}</Label>
                  <Textarea
                    placeholder={t("knowledge.tab.contentPlaceholder")}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={10}
                    className="font-mono text-sm max-h-[40vh] resize-y"
                  />
                </div>
              </div>
              <DialogFooter className="shrink-0">
                <Button
                  onClick={handleUpload}
                  disabled={uploading || !filename.trim() || !content.trim()}
                >
                  {uploading ? t("common.saving") : t("knowledge.tab.upload")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
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
                    <StatusBadge status={doc.status} t={t} />
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
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-destructive">
                      <Trash2 className="size-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("knowledge.tab.deleteTitle")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("knowledge.tab.deleteDescription", {
                          name: doc.filename,
                        })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => handleDelete(doc.id)}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {t("common.delete")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
        </div>
      )}

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
