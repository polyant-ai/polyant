// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Download } from "lucide-react";
import { parseUTC } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  type RequiredEnvEntry,
  type ToolInfo,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

interface EnvVarDef {
  name: string;
  description: string;
  sensitive: boolean;
}

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
        setEnvVars(
          data.requiredEnv?.map((e) => ({
            name: e.name,
            description: e.description ?? "",
            sensitive: e.sensitive,
          })) ?? [],
        );
        setRequiredTools(data.requiredTools ?? []);
        setAvailableTools(toolsData.tools ?? []);
      } catch (err) {
        toast.error(
          getUserErrorMessage(err, t("skills.fetchFailed") ?? "Failed to load skill"),
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
        getUserErrorMessage(err, t("skills.fetchFailed") ?? "Failed to load versions"),
      );
    } finally {
      setVersionsLoading(false);
    }
  };

  const addEnvVar = () => {
    setEnvVars((prev) => [...prev, { name: "", description: "", sensitive: true }]);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  };

  const updateEnvVar = (
    index: number,
    field: keyof EnvVarDef,
    value: string | boolean,
  ) => {
    setEnvVars((prev) =>
      prev.map((v, i) => (i === index ? { ...v, [field]: value } : v)),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const validEnvVars = envVars
        .filter((e) => e.name.trim())
        .map((e) => ({
          name: e.name.trim(),
          ...(e.description.trim() ? { description: e.description.trim() } : {}),
          sensitive: e.sensitive,
        }));

      const reqEnv = validEnvVars.length > 0 ? validEnvVars : undefined;

      const updated = await api.skillLibrary.update(params.name, {
        description,
        content,
        requiredEnv: reqEnv,
        requiredTools: requiredTools.length > 0 ? requiredTools : undefined,
        changelog: changelog.trim() || undefined,
      });

      setSkill(updated);
      setChangelog("");
      toast.success(t("common.saved") ?? "Saved");
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
        getUserErrorMessage(err, t("skills.deleteFailed") ?? "Failed to archive skill"),
      );
    } finally {
      setArchiving(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await api.exportImport.exportSkill(params.name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `${params.name}-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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
        getUserErrorMessage(err, t("skills.fetchFailed") ?? "Failed to load version"),
      );
    }
  };

  if (loading) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("common.loading")}
        </h1>
      </div>
    );
  }

  if (!skill) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("skills.notFound")}
        </h1>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">{skill.name}</h1>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

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

            <div className="space-y-2">
              <Label>{t("skills.form.requiredEnv")}</Label>
              {envVars.length > 0 && (
                <div className="space-y-3">
                  {envVars.map((envVar, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-3 rounded-lg border p-3"
                    >
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-3">
                          <Input
                            value={envVar.name}
                            onChange={(e) =>
                              updateEnvVar(
                                index,
                                "name",
                                e.target.value
                                  .toUpperCase()
                                  .replace(/[^A-Z0-9_]/g, "_"),
                              )
                            }
                            placeholder={t("skills.form.envNamePlaceholder")}
                            className="font-mono text-sm"
                          />
                          <div className="flex items-center gap-2 shrink-0">
                            <Switch
                              checked={envVar.sensitive}
                              onCheckedChange={(checked) =>
                                updateEnvVar(index, "sensitive", checked)
                              }
                            />
                            <span className="text-xs text-muted-foreground">
                              {t("skills.form.envSecret")}
                            </span>
                          </div>
                        </div>
                        <Input
                          value={envVar.description}
                          onChange={(e) =>
                            updateEnvVar(index, "description", e.target.value)
                          }
                          placeholder={t("skills.form.envDescPlaceholder")}
                          className="text-sm"
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeEnvVar(index)}
                        className="shrink-0 mt-0.5"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={addEnvVar}
                className="mt-2"
              >
                <Plus className="mr-2 size-4" />
                {t("skills.form.addVariable")}
              </Button>
            </div>

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
