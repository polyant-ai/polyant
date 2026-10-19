// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { parseUTC } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ChipTabs } from "@/components/layout/chip-tabs";
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
import {
  api,
  getUserErrorMessage,
  type LibrarySkillDetail,
  type SkillVersion,
  type ToolInfo,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { EnvVarsEditor, toEnvVarDefs, toRequiredEnv, type EnvVarDef } from "@/components/skills/env-vars-editor";

export default function SkillDetailPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const { t } = useI18n();

  const [skill, setSkill] = useState<LibrarySkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Content tab state
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [changelog, setChangelog] = useState("");
  const [envVars, setEnvVars] = useState<EnvVarDef[]>([]);
  const [requiredTools, setRequiredTools] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);

  // Versions tab state
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<SkillVersion | null>(null);

  // Export state
  const [exporting, setExporting] = useState(false);

  // Settings tab state
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    const fetchSkill = async () => {
      try {
        const [data, toolsData] = await Promise.all([
          api.skillLibrary.get(params.name),
          api.tools.catalog(),
        ]);
        setSkill(data);
        setDescription(data.description);
        setContent(data.content);
        setEnvVars(toEnvVarDefs(data.requiredEnv));
        setRequiredTools(data.requiredTools ?? []);
        setAvailableTools(toolsData.tools ?? []);
      } catch (err) {
        toast.error(
          getUserErrorMessage(err, t("skills.fetchFailed")),
        );
      } finally {
        setLoading(false);
      }
    };
    fetchSkill();
  }, [params.name]);

  const fetchVersions = async () => {
    setVersionsLoading(true);
    try {
      const data = await api.skillLibrary.versions(params.name);
      setVersions(data.versions);
    } catch (err) {
      toast.error(
        getUserErrorMessage(err, t("skills.fetchFailed")),
      );
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const reqEnv = toRequiredEnv(envVars);

      const updated = await api.skillLibrary.update(params.name, {
        description,
        content,
        requiredEnv: reqEnv,
        requiredTools: requiredTools.length > 0 ? requiredTools : undefined,
        changelog: changelog.trim() || undefined,
      });

      setSkill(updated);
      setChangelog("");
      toast.success(t("common.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.form.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    setArchiving(true);
    try {
      await api.skillLibrary.delete(params.name);
      toast.success(t("skills.detail.settings.archived"));
      router.push("/skills");
    } catch (err) {
      toast.error(
        getUserErrorMessage(err, t("skills.deleteFailed")),
      );
    } finally {
      setArchiving(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await api.exportImport.exportSkill(params.name);
      const date = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `${params.name}-${date}.json`);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("exportImport.export.failed")));
    } finally {
      setExporting(false);
    }
  };

  const handleVersionClick = async (version: SkillVersion) => {
    if (selectedVersion?.id === version.id) {
      setSelectedVersion(null);
      return;
    }
    try {
      const data = await api.skillLibrary.getVersion(params.name, version.version);
      setSelectedVersion(data);
    } catch (err) {
      toast.error(
        getUserErrorMessage(err, t("skills.fetchFailed")),
      );
    }
  };

  if (loading) {
    return (
      <div>
        <PageHeader title={t("common.loading")} />
      </div>
    );
  }

  if (!skill) {
    return (
      <div>
        <PageHeader title={t("skills.notFound")} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={skill.name}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              disabled={exporting}
              className="gap-1.5"
            >
              <Download className="h-4 w-4" />
              {exporting ? t("exportImport.export.downloading") : t("exportImport.export.button")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("common.saving") : t("common.saveSingle")}
            </Button>
          </>
        }
      />

      <ChipTabs
        className="mt-6"
        onValueChange={(val) => {
          if (val === "versions" && versions.length === 0) {
            fetchVersions();
          }
        }}
        tabs={[
          {
            value: "content",
            label: t("skills.detail.tabs.content"),
            children: (
              <>
          <div className="mt-4 space-y-6 max-w-2xl">
            <div className="space-y-2">
              <Label htmlFor="name">{t("skills.form.name")}</Label>
              <Input
                id="name"
                value={skill.name}
                readOnly
                className="opacity-60"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">{t("skills.form.description")}</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("skills.form.descriptionPlaceholder")}
              />
            </div>

            <EnvVarsEditor value={envVars} onChange={setEnvVars} />

            <div className="space-y-2">
              <Label>{t("skills.detail.requiredTools")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("skills.detail.requiredToolsHint")}
              </p>
              {availableTools.length > 0 ? (
                <div className="grid grid-cols-2 gap-2 rounded-lg border p-3 max-h-[200px] overflow-y-auto">
                  {availableTools.map((tool) => (
                    <label
                      key={tool.name}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={requiredTools.includes(tool.name)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setRequiredTools((prev) => [...prev, tool.name]);
                          } else {
                            setRequiredTools((prev) =>
                              prev.filter((t) => t !== tool.name),
                            );
                          }
                        }}
                      />
                      <span className="font-mono text-xs">{tool.name}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("common.loading")}
                </p>
              )}
              {requiredTools.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {requiredTools.map((name) => (
                    <Badge key={name} variant="secondary" className="text-[10px] px-1.5 py-0">
                      {name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="content">{t("skills.form.content")}</Label>
              <Textarea
                id="content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={t("skills.form.contentPlaceholder")}
                className="min-h-[400px] font-mono text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="changelog">{t("skills.detail.changelog")}</Label>
              <Textarea
                id="changelog"
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder={t("skills.detail.changelogPlaceholder")}
                className="min-h-[80px] text-sm"
              />
            </div>
          </div>
              </>
            ),
          },
          {
            value: "versions",
            label: t("skills.detail.tabs.versions"),
            children: (
              <>
          <div className="mt-4 max-w-2xl">
            {versionsLoading ? (
              <p className="text-muted-foreground">{t("common.loading")}</p>
            ) : versions.length === 0 ? (
              <p className="text-muted-foreground">
                {t("skills.detail.versions.empty")}
              </p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {t("skills.detail.versions.version")}
                      </TableHead>
                      <TableHead>
                        {t("skills.detail.versions.changelog")}
                      </TableHead>
                      <TableHead>
                        {t("skills.detail.versions.createdAt")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versions.map((version, index) => (
                      <TableRow
                        key={version.id}
                        className="cursor-pointer"
                        onClick={() => handleVersionClick(version)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0"
                            >
                              v{version.version}
                            </Badge>
                            {index === 0 && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0 bg-success/10 text-success"
                              >
                                {t("skills.detail.versions.current")}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {version.changelog || "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {version.createdAt
                            ? parseUTC(version.createdAt).toLocaleDateString()
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {selectedVersion && (
                  <div className="mt-4 space-y-2">
                    <Label>
                      {t("skills.detail.versions.content")} — v
                      {selectedVersion.version}
                    </Label>
                    <Textarea
                      value={selectedVersion.content}
                      readOnly
                      className="min-h-[300px] font-mono text-sm opacity-80"
                    />
                  </div>
                )}
              </>
            )}
          </div>
              </>
            ),
          },
          {
            value: "settings",
            label: t("skills.detail.tabs.settings"),
            children: (
              <>
          <div className="mt-4 space-y-6 max-w-2xl">
            <div className="space-y-2">
              <Label>{t("skills.detail.settings.category")}</Label>
              <Input value={skill.category ?? "—"} readOnly className="opacity-60" />
            </div>

            <div className="space-y-2">
              <Label>{t("skills.detail.settings.status")}</Label>
              <Input value="active" readOnly className="opacity-60" />
            </div>

            <div className="rounded-lg border border-destructive p-4 space-y-3">
              <h3 className="text-sm font-semibold text-destructive">
                {t("skills.detail.settings.dangerZone")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("skills.detail.settings.archiveDescription")}
              </p>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={archiving}>
                    {t("skills.detail.settings.archive")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("skills.detail.settings.archive")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("skills.detail.settings.archiveDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleArchive}>
                      {t("skills.detail.settings.archive")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
