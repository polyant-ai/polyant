// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { parseUTC } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadFailed } from "@/components/ui/load-failed";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ChipTabs } from "@/components/layout/chip-tabs";
import { ListDrawer, DrawerDeleteButton } from "@/components/list-drawer";
import { ListHead, ListRow, ListTable } from "@/components/list-table";
import { ListLoading } from "@/components/list-states";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import {
  api,
  getUserErrorMessage,
  type LibrarySkillDetail,
  type SkillVersion,
  type ToolInfo,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";
import { EnvVarsEditor, toEnvVarDefs, toRequiredEnv, type EnvVarDef } from "@/components/skills/env-vars-editor";

/**
 * One skill of the library, opened from its row: its content and its versions
 * in two tabs, with save, export and delete in the footer. Mounted afresh for
 * each skill (the page gives it a `key`), so nothing of the previous skill's
 * form is left behind.
 */
export function SkillSheet({
  name,
  onClose,
  onChanged,
}: {
  /** The skill's slug, or null while the drawer is closed. */
  name: string | null;
  onClose: () => void;
  /** Called after the skill was saved or deleted, so the list reads it again. */
  onChanged: () => void;
}) {
  const { t } = useI18n();

  const [skill, setSkill] = useState<LibrarySkillDetail | null>(null);
  const [loading, setLoading] = useState(name !== null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("content");

  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [changelog, setChangelog] = useState("");
  const [envVars, setEnvVars] = useState<EnvVarDef[]>([]);
  const [requiredTools, setRequiredTools] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([]);

  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<SkillVersion | null>(null);

  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (name === null) return;
    let cancelled = false;
    (async () => {
      try {
        const [data, toolsData] = await Promise.all([api.skillLibrary.get(name), api.tools.catalog()]);
        if (cancelled) return;
        setSkill(data);
        setDisplayName(data.displayName);
        setDescription(data.description);
        setContent(data.content);
        setEnvVars(toEnvVarDefs(data.requiredEnv));
        setRequiredTools(data.requiredTools ?? []);
        setAvailableTools(toolsData.tools ?? []);
      } catch (err) {
        if (!cancelled) toast.error(getUserErrorMessage(err, t("skills.fetchFailed")));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per skill; the drawer is remounted for the next one
  }, [name]);

  const fetchVersions = async () => {
    if (name === null) return;
    setVersionsLoading(true);
    try {
      const data = await api.skillLibrary.versions(name);
      // The engine lists oldest first. Publishing a version makes it the current one,
      // so the newest is the current one: list it first.
      setVersions([...data.versions].sort((a, b) => parseUTC(b.createdAt).getTime() - parseUTC(a.createdAt).getTime()));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.fetchFailed")));
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleSave = async () => {
    if (name === null) return;
    setSaving(true);
    try {
      const updated = await api.skillLibrary.update(name, {
        displayName: displayName.trim(),
        description,
        content,
        requiredEnv: toRequiredEnv(envVars),
        requiredTools: requiredTools.length > 0 ? requiredTools : undefined,
        changelog: changelog.trim() || undefined,
      });
      setSkill(updated);
      setDisplayName(updated.displayName);
      setChangelog("");
      toast.success(t("common.saved"));
      onChanged();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.form.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (name === null) return;
    setDeleting(true);
    try {
      await api.skillLibrary.delete(name);
      toast.success(t("common.deleted"));
      setConfirmDelete(false);
      onChanged();
      onClose();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.deleteFailed")));
    } finally {
      setDeleting(false);
    }
  };

  const handleExport = async () => {
    if (name === null) return;
    setExporting(true);
    try {
      const blob = await api.exportImport.exportSkill(name);
      downloadBlob(blob, `${name}-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("exportImport.export.failed")));
    } finally {
      setExporting(false);
    }
  };

  const handleVersionClick = async (version: SkillVersion) => {
    if (name === null) return;
    if (selectedVersion?.id === version.id) {
      setSelectedVersion(null);
      return;
    }
    try {
      setSelectedVersion(await api.skillLibrary.getVersion(name, version.version));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("skills.fetchFailed")));
    }
  };

  const contentTab = (
    <div className="mt-4 space-y-6">
      <div className="space-y-2">
        <Label htmlFor="displayName">{t("skills.form.name")}</Label>
        <Input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={255} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="slug">{t("skills.form.slug")}</Label>
        <Input id="slug" value={skill?.name ?? ""} readOnly className="font-mono opacity-60" />
        <p className="text-xs text-muted-foreground">{t("skills.form.slugHint")}</p>
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
        <p className="text-xs text-muted-foreground">{t("skills.detail.requiredToolsHint")}</p>
        {availableTools.length > 0 ? (
          <div className="grid max-h-[200px] grid-cols-2 gap-2 overflow-y-auto rounded-lg border p-3">
            {availableTools.map((tool) => (
              <label key={tool.name} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={requiredTools.includes(tool.name)}
                  onCheckedChange={(checked) =>
                    setRequiredTools((prev) => (checked ? [...prev, tool.name] : prev.filter((n) => n !== tool.name)))
                  }
                />
                <span className="font-mono text-xs">{tool.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
        )}
        {requiredTools.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {requiredTools.map((toolName) => (
              <Badge key={toolName} variant="secondary">
                {toolName}
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
  );

  const versionsTab = (
    <div className="mt-4">
      {versionsLoading ? (
        <ListLoading className="" />
      ) : versions.length === 0 ? (
        <p className="text-muted-foreground">{t("skills.detail.versions.empty")}</p>
      ) : (
        <>
          <ListTable className="mt-0">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <ListHead className="w-32">{t("skills.detail.versions.version")}</ListHead>
                <ListHead>{t("skills.detail.versions.changelog")}</ListHead>
                <ListHead className="w-32">{t("skills.detail.versions.createdAt")}</ListHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version, index) => (
                <ListRow
                  key={version.id}
                  onOpen={() => handleVersionClick(version)}
                  selected={selectedVersion?.id === version.id}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">v{version.version}</Badge>
                      {index === 0 && (
                        <Badge variant="secondary" className="bg-success/10 text-success">
                          {t("skills.detail.versions.current")}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">{version.changelog || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {version.createdAt ? parseUTC(version.createdAt).toLocaleDateString() : "—"}
                  </TableCell>
                </ListRow>
              ))}
            </TableBody>
          </ListTable>

          {selectedVersion && (
            <div className="mt-4 space-y-2">
              <Label>
                {t("skills.detail.versions.content")} — v{selectedVersion.version}
              </Label>
              <Textarea value={selectedVersion.content} readOnly className="min-h-[300px] font-mono text-sm opacity-80" />
            </div>
          )}
        </>
      )}
    </div>
  );

  const ready = !loading && skill !== null;

  return (
    <>
      <ListDrawer
        open={name !== null}
        onOpenChange={(open) => !open && onClose()}
        title={ready ? skill.displayName : loading ? t("common.loading") : t("skills.notFound")}
        description={ready ? <code className="text-xs">{skill.name}</code> : (name ?? "")}
        destructive={ready ? <DrawerDeleteButton onClick={() => setConfirmDelete(true)} /> : undefined}
        actions={
          ready ? (
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              <Download className="size-4" aria-hidden />
              {exporting ? t("exportImport.export.downloading") : t("exportImport.export.button")}
            </Button>
          ) : undefined
        }
        // Only the content tab has anything to save.
        primary={
          ready && tab === "content" ? (
            <Button onClick={handleSave} disabled={saving || displayName.trim() === ""}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          ) : undefined
        }
      >
        {loading ? (
          <ListLoading className="" />
        ) : skill === null ? (
          <LoadFailed message={t("skills.fetchFailed")} />
        ) : (
          <ChipTabs
            value={tab}
            onValueChange={(next) => {
              setTab(next);
              if (next === "versions" && versions.length === 0) void fetchVersions();
            }}
            tabs={[
              { value: "content", label: t("skills.detail.tabs.content"), children: contentTab },
              { value: "versions", label: t("skills.detail.tabs.versions"), children: versionsTab },
            ]}
          />
        )}
      </ListDrawer>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("skills.deleteTitle")}
        description={t("skills.deleteDescription", { name: skill?.displayName ?? name ?? "" })}
        confirmLabel={t("common.delete")}
        onConfirm={handleDelete}
        pending={deleting}
      />
    </>
  );
}
